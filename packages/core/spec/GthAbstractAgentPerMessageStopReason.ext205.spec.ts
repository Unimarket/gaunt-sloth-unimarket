/**
 * [[EXT-205]] — each streamed model message's stop reason is recorded and read on its own.
 *
 * The shape is the one measured on ten real `gth pr`/`gth review` runs on Gemini via Vertex: the
 * answer turn streams under `langgraph_node: model_request`, then the review rating call streams
 * under `review-rate.after_agent` with a different message id and NO ToolMessage between them.
 * Each message carries its finish reason once, on its last chunk, in
 * `additional_kwargs.finishReason`; `response_metadata` holds only `model_provider`. Folded into one
 * aggregate, the two reasons concatenated (`stopstop`), so a truncated answer read
 * `max_tokensstop` and went unclassified.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage, ToolCall } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentStreamEvent } from '#src/core/types.js';

const consoleUtilsMock = {
  displayInfo: vi.fn(),
  displayToolIndication: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

const systemUtilsMock = {
  waitForEscape: vi.fn(),
  stopWaitingForEscape: vi.fn(),
  getUseColour: vi.fn(() => false),
  stdout: { isTTY: false, write: vi.fn() },
  env: {},
};
vi.mock('#src/utils/systemUtils.js', () => systemUtilsMock);

const runConfig: RunnableConfig = { configurable: { thread_id: 't1' } };

const ANSWER_ID = 'run-019a0ec6-4a99-7000-8000-00008135d8c7';
const RATING_ID = 'run-019a0ec6-4a99-7000-8000-00001ac1b9af';
const ANSWER_META = { langgraph_node: 'model_request' };
const RATING_META = { langgraph_node: 'review-rate.after_agent' };

type StreamItem = [BaseMessage, Record<string, unknown>];

/** A Gemini-on-Vertex chunk: the reason, when there is one, only in `additional_kwargs`. */
function geminiChunk(
  id: string | undefined,
  content: string,
  finishReason?: string,
  toolCalls: ToolCall[] = []
): AIMessageChunk {
  return new AIMessageChunk({
    ...(id ? { id } : {}),
    content,
    additional_kwargs: finishReason ? { finishReason } : {},
    response_metadata: { model_provider: 'google' },
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  });
}

/** The answer turn: three chunks, the reason (if any) on the last. */
function answer(finishReason?: string): StreamItem[] {
  return [
    [geminiChunk(ANSWER_ID, 'The change '), ANSWER_META],
    [geminiChunk(ANSWER_ID, 'looks '), ANSWER_META],
    [geminiChunk(ANSWER_ID, 'fine', finishReason), ANSWER_META],
  ];
}

/** The rating call: a tool-call chunk, then an empty chunk carrying the reason. */
function rating(finishReason: string): StreamItem[] {
  return [
    [
      geminiChunk(RATING_ID, '', undefined, [
        { type: 'tool_call', id: 'call_1', name: 'gth_review_rate', args: { rate: 10 } },
      ]),
      RATING_META,
    ],
    [geminiChunk(RATING_ID, '', finishReason), RATING_META],
  ];
}

describe('[[EXT-205]] a stop reason per streamed model message', () => {
  let GthAbstractAgent: typeof import('#src/core/GthAbstractAgent.js').GthAbstractAgent;

  beforeEach(async () => {
    vi.resetAllMocks();
    systemUtilsMock.getUseColour.mockReturnValue(false);
    ({ GthAbstractAgent } = await import('#src/core/GthAbstractAgent.js'));
  });

  function agentStreaming(items: StreamItem[]) {
    class TestAgent extends GthAbstractAgent {
      async init(): Promise<void> {
        /* graph injected directly */
      }
    }
    const agent = new TestAgent(() => {});
    (agent as unknown as { config: unknown }).config = { writeBinaryOutputsToFile: false };
    (agent as unknown as { agent: unknown }).agent = {
      async invoke() {
        throw new Error('invoke not used');
      },
      async stream() {
        return (async function* () {
          for (const item of items) yield item;
        })();
      },
    };
    return agent;
  }

  /** Drive the string-streaming path to its end and return what it produced. */
  async function runStringPath(agent: ReturnType<typeof agentStreaming>): Promise<string> {
    const stream = await agent.stream([new HumanMessage('review this')], runConfig);
    let text = '';
    for await (const piece of stream) text += piece;
    return text;
  }

  async function runEventPath(
    agent: ReturnType<typeof agentStreaming>
  ): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of agent.streamWithEvents([new HumanMessage('q')], runConfig)) {
      events.push(event);
    }
    return events;
  }

  function tokens(agent: ReturnType<typeof agentStreaming>): Array<string | null> {
    return agent.getFinishReasonObservations().map((o) => o.token);
  }

  describe('the string-streaming path (`pr` and `review`)', () => {
    it('classifies a MAX_TOKENS answer followed by the rating call as `output_truncated`', async () => {
      const agent = agentStreaming([...answer('MAX_TOKENS'), ...rating('STOP')]);

      await runStringPath(agent);

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-stop-metadata',
        category: 'output_truncated',
        detail: 'max_tokens',
      });
      expect(tokens(agent)).toEqual(['max_tokens', 'stop']);
    });

    it('does not let the rating call’s own truncation classify the turn', async () => {
      const agent = agentStreaming([...answer('STOP'), ...rating('MAX_TOKENS')]);

      await runStringPath(agent);

      expect(agent.getTerminationReason()).toBeNull();
      expect(tokens(agent)).toEqual(['stop', 'max_tokens']);
    });

    it('does not surface a refusal on the rating call as the model declining the turn', async () => {
      const agent = agentStreaming([...answer('STOP'), ...rating('SAFETY')]);

      const text = await runStringPath(agent);

      expect(agent.getTerminationReason()).toBeNull();
      expect(text).not.toContain('declined');
      expect(tokens(agent)).toEqual(['stop', 'safety']);
    });

    it('still surfaces a refusal on the answer itself', async () => {
      const agent = agentStreaming([...answer('SAFETY'), ...rating('STOP')]);

      const text = await runStringPath(agent);

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-stop-metadata',
        category: 'content_refusal',
        provider: 'google',
      });
      expect(text).toContain('declined');
    });

    it('records a reasonless answer as absent, not as the rating call’s reason', async () => {
      const agent = agentStreaming([...answer(), ...rating('STOP')]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual([null, 'stop']);
      expect(agent.getTerminationReason()).toBeNull();
    });

    it('records the message a ToolMessage closes, even with no reason on it', async () => {
      const agent = agentStreaming([
        ...answer(),
        [new ToolMessage({ content: 'ok', tool_call_id: 'call_0', name: 'read_file' }), {}],
        ...rating('STOP'),
      ]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual([null, 'stop']);
    });

    it('classifies the turn from the message it ended on, not an earlier tool round', async () => {
      const toolRoundId = 'run-019a0ec6-4a99-7000-8000-0000000000aa';
      const agent = agentStreaming([
        [
          geminiChunk(toolRoundId, '', 'MAX_TOKENS', [
            { type: 'tool_call', id: 'call_0', name: 'read_file', args: {} },
          ]),
          ANSWER_META,
        ],
        [new ToolMessage({ content: 'ok', tool_call_id: 'call_0', name: 'read_file' }), {}],
        ...answer('STOP'),
      ]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual(['max_tokens', 'stop']);
      expect(agent.getTerminationReason()).toBeNull();
    });

    it('does not classify from a round a ToolMessage closed when the stream ends there', async () => {
      // The approval gate's shape: the stream suspends after the round's result, with no answer.
      const agent = agentStreaming([
        [
          geminiChunk(ANSWER_ID, '', 'MAX_TOKENS', [
            { type: 'tool_call', id: 'call_0', name: 'read_file', args: {} },
          ]),
          ANSWER_META,
        ],
        [new ToolMessage({ content: 'ok', tool_call_id: 'call_0', name: 'read_file' }), {}],
      ]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual(['max_tokens']);
      expect(agent.getTerminationReason()).toBeNull();
    });

    it('classifies from the LAST of two answer-side messages in one round', async () => {
      // A retried model call inside `model_request`: two ids, same node, no ToolMessage between.
      const retriedId = 'run-019a0ec6-4a99-7000-8000-0000000000bb';
      const agent = agentStreaming([
        [geminiChunk(ANSWER_ID, 'first attempt', 'STOP'), ANSWER_META],
        [geminiChunk(retriedId, 'second attempt', 'MAX_TOKENS'), ANSWER_META],
      ]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual(['stop', 'max_tokens']);
      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-stop-metadata',
        category: 'output_truncated',
      });
    });

    it('splits on a change of graph node when the chunks carry no id', async () => {
      const agent = agentStreaming([
        [geminiChunk(undefined, 'cut '), ANSWER_META],
        [geminiChunk(undefined, '', 'MAX_TOKENS'), ANSWER_META],
        [geminiChunk(undefined, ''), RATING_META],
        [geminiChunk(undefined, '', 'STOP'), RATING_META],
      ]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual(['max_tokens', 'stop']);
      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.stream-stop-metadata',
        category: 'output_truncated',
      });
    });

    it('does not split a message whose chunks carry no id and no node', async () => {
      const agent = agentStreaming([
        [geminiChunk(undefined, 'a '), {}],
        [geminiChunk(undefined, 'partial'), {}],
        [geminiChunk(undefined, '', 'MAX_TOKENS'), {}],
      ]);

      await runStringPath(agent);

      expect(tokens(agent)).toEqual(['max_tokens']);
      expect(agent.getTerminationReason()).toMatchObject({ category: 'output_truncated' });
    });
  });

  describe('the typed-event path (TUI, ACP, AG-UI), read the same way', () => {
    it('classifies a MAX_TOKENS answer followed by a hook’s model call as `output_truncated`', async () => {
      const agent = agentStreaming([...answer('MAX_TOKENS'), ...rating('STOP')]);

      await runEventPath(agent);

      expect(agent.getTerminationReason()).toMatchObject({
        site: 'agent.events-stop-metadata',
        category: 'output_truncated',
        detail: 'max_tokens',
      });
      expect(tokens(agent)).toEqual(['max_tokens', 'stop']);
    });

    it('records a reasonless answer as absent and does not classify from the hook', async () => {
      const agent = agentStreaming([...answer(), ...rating('MAX_TOKENS')]);

      await runEventPath(agent);

      expect(tokens(agent)).toEqual([null, 'max_tokens']);
      expect(agent.getTerminationReason()).toBeNull();
    });

    it('does not surface a refusal on a hook’s model call as a refusal text event', async () => {
      const agent = agentStreaming([...answer('STOP'), ...rating('SAFETY')]);

      const events = await runEventPath(agent);

      const text = events.map((e) => (e.type === 'text' ? e.delta : '')).join('');
      expect(text).not.toContain('declined');
      expect(agent.getTerminationReason()).toBeNull();
    });

    it('still announces a tool call made by the hook’s message', async () => {
      const agent = agentStreaming([...answer('STOP'), ...rating('STOP')]);

      const events = await runEventPath(agent);

      expect(events).toContainEqual({ type: 'tool_start', id: 'call_1', name: 'gth_review_rate' });
    });
  });
});
