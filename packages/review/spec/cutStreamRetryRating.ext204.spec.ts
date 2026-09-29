/**
 * [[EXT-204]] — on `review`, a run whose answer was cut off and recovered is rated ONCE, on the
 * recovered review.
 *
 * The rating is an `afterAgent` hook, so it runs when the agent loop ends. In the issue #465
 * reproduction the loop ended on the cut, thought-only message, and the rating scored that empty
 * review PASS 10/10 before the runner reported the empty turn. Here the real rating middleware runs
 * on a real `createAgent` graph through a real `GthAgentRunner`, on a scripted Gemini-like model that
 * serves both the review and the rating call and records every request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { deleteArtifact, getArtifact } from '@gaunt-sloth/core/state/artifactStore.js';
import {
  REVIEW_RATE_ARTIFACT_KEY,
  createReviewRateMiddleware,
  type ReviewRatingArtifact,
} from '#src/middleware/reviewRateMiddleware.js';

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readModePrompt: vi.fn(() => 'review-mode-prompt'),
  };
});

vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
    displayToolIndication: vi.fn(),
  };
});

/** The rating tool's name; the middleware keeps its constant private. */
const REVIEW_RATE_TOOL_NAME = 'gth_review_rate';

const REVIEW_TEXT = 'The recovered review: the change is sound.';

/** Is this request the rating call? It ends with the rating instructions, a human turn. */
function isRatingRequest(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1];
  return HumanMessage.isInstance(last) && String(last.content).includes(REVIEW_RATE_TOOL_NAME);
}

/**
 * The review's calls, in order: a tool round, a reply cut off with thought parts only and no finish
 * reason, then the retry's answer. The rating call is recognised by its request and scored 7.
 */
class ScriptedReviewModel extends BaseChatModel {
  readonly reviewCalls: BaseMessage[][] = [];
  readonly ratingCalls: BaseMessage[][] = [];

  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-review';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    if (messages[messages.length - 1]?.getType() === 'ai') {
      throw new Error('Requests ending with a model turn are not supported.');
    }
    let reply: AIMessage;
    if (isRatingRequest(messages)) {
      this.ratingCalls.push([...messages]);
      reply = new AIMessage({
        content: '',
        additional_kwargs: { finishReason: 'STOP' },
        tool_calls: [
          { name: REVIEW_RATE_TOOL_NAME, args: { rate: 7, comment: 'scored' }, id: 'rate-1' },
        ],
      });
    } else {
      this.reviewCalls.push([...messages]);
      const call = this.reviewCalls.length;
      reply =
        call === 1
          ? new AIMessage({
              content: '',
              additional_kwargs: { finishReason: 'STOP' },
              tool_calls: [{ name: 'lookup', args: { q: 'spec' }, id: 'call-1' }],
            })
          : call === 2
            ? new AIMessage({
                content: [{ type: 'text', text: 'delving into the spec', thought: true }] as never,
              })
            : new AIMessage({ content: REVIEW_TEXT, additional_kwargs: { finishReason: 'STOP' } });
    }
    return { generations: [{ message: reply, text: '' }] };
  }

  /** Stream the content, then the finish reason on a final chunk when there is one. */
  async *_streamResponseChunks(messages: BaseMessage[]) {
    const reply = (await this._generate(messages)).generations[0].message as AIMessage;
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        content: reply.content,
        tool_call_chunks: (reply.tool_calls ?? []).map((call, index) => ({
          type: 'tool_call_chunk' as const,
          name: call.name,
          args: JSON.stringify(call.args),
          id: call.id,
          index,
        })),
      }),
    });
    const finishReason = reply.additional_kwargs?.finishReason;
    if (finishReason !== undefined) {
      yield new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk({ content: '', additional_kwargs: { finishReason } }),
      });
    }
  }
}

const lookupTool = () =>
  tool(async () => 'LOOKED-UP', {
    name: 'lookup',
    description: 'Look something up.',
    schema: z.object({ q: z.string() }),
  });

describe('[[EXT-204]] a recovered review is rated once, on the recovered review', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    deleteArtifact(REVIEW_RATE_ARTIFACT_KEY);
  });
  afterEach(() => deleteArtifact(REVIEW_RATE_ARTIFACT_KEY));

  for (const streamOutput of [true, false]) {
    it(`${streamOutput ? 'streaming' : 'non-streaming'}: one rating call, made on the recovered answer`, async () => {
      const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
      const model = new ScriptedReviewModel();
      const config = {
        streamOutput,
        contentSource: 'file',
        requirementSource: 'file',
        filesystem: 'none',
        useColour: false,
        writeOutputToFile: false,
        writeBinaryOutputsToFile: false,
        streamSessionInferenceLog: false,
        canInterruptInferenceWithEsc: false,
        includeCurrentDateAfterGuidelines: true,
        commands: {},
        llm: model,
        tools: [lookupTool()],
      } as unknown as GthConfig;
      config.middleware = [await createReviewRateMiddleware({}, config)] as never;
      const runner = new GthAgentRunner(vi.fn(), {
        resolveMiddleware: async (middleware) => middleware ?? [],
      });
      await runner.init('review', config, new MemorySaver());

      const answer = await runner.processMessages([new HumanMessage('review this diff')]);

      expect(answer).toContain(REVIEW_TEXT);
      // The tool round, the cut reply, and one retry.
      expect(model.reviewCalls).toHaveLength(3);

      // Rated once, and on the review that was actually produced: the rating request carries the
      // recovered answer as the model's last word, and no thought-only reply anywhere.
      expect(model.ratingCalls).toHaveLength(1);
      const rated = model.ratingCalls[0];
      const modelTurns = rated.filter((m) => AIMessage.isInstance(m));
      expect(modelTurns[modelTurns.length - 1]?.text).toContain(REVIEW_TEXT);
      expect(
        modelTurns.filter(
          (m) =>
            (m.tool_calls?.length ?? 0) === 0 &&
            !String(m.text).includes(REVIEW_TEXT) &&
            m.additional_kwargs?.finishReason === undefined
        )
      ).toEqual([]);
      expect(getArtifact<ReviewRatingArtifact>(REVIEW_RATE_ARTIFACT_KEY)?.rate).toBe(7);
      expect(runner.getTerminationReason()).toMatchObject({ category: 'completed' });
    });
  }
});
