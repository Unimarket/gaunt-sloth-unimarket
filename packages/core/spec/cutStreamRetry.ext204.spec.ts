/**
 * [[EXT-204]] — a model reply cut off before it finished is retried once, inside the model call.
 *
 * The measured shape (Gemini 3.8 Flash on VertexAI, issue #465): after a tool result, the model's
 * message arrives with only `thought: true` text parts, no answer text, no tool call and no finish
 * reason. Driven through a REAL `GthAgentRunner` over a REAL `createAgent` graph, on all three
 * paths (string stream, non-streaming `invoke`, typed events). The model is scripted, records every
 * message list it is handed, and — like Gemini — rejects a request whose last message is an AI
 * message with a 400, so "the thread never ends with a model turn" is asserted on what the model
 * RECEIVED rather than on what the runner returned.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { AgentStreamEvent } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { terminationReasonOf } from '#src/core/terminationReason.js';
import { MiddlewareError } from 'langchain';

type CutStreamRetryModule = typeof import('#src/core/cutStreamRetry.js');
let isCutModelReply: CutStreamRetryModule['isCutModelReply'];
let createCutStreamRetryMiddleware: CutStreamRetryModule['createCutStreamRetryMiddleware'];

beforeEach(async () => {
  vi.resetAllMocks();
  ({ isCutModelReply, createCutStreamRetryMiddleware } =
    await import('#src/core/cutStreamRetry.js'));
});

vi.mock('#src/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readChatPrompt: vi.fn(() => 'chat-mode-prompt'),
    readCodePrompt: vi.fn(() => 'code-mode-prompt'),
    readExecPrompt: vi.fn(() => 'exec-mode-prompt'),
  };
});

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
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

const MODEL_TURN_MESSAGE = 'Requests ending with a model turn are not supported.';

function geminiBadRequest(): Error {
  const error = new Error(MODEL_TURN_MESSAGE) as Error & { statusCode: number };
  error.name = 'RequestError';
  error.statusCode = 400;
  return error;
}

type Script = (call: number, messages: BaseMessage[]) => AIMessage | Error;

/** The measured cut: thought parts only, and no finish reason anywhere. */
const cut = () =>
  new AIMessage({
    content: [
      { type: 'text', text: 'I am now delving into the specifics of the spec', thought: true },
    ] as never,
  });

/** A complete message, with Gemini's finish reason in the key Vertex sends it under. */
const complete = (content: AIMessage['content'], extra: Record<string, unknown> = {}) =>
  new AIMessage({ content, additional_kwargs: { finishReason: 'STOP' }, ...extra });

/** A complete reply that says `STOP` and nothing else: the model's own decision. */
const completeEmpty = () =>
  complete([{ type: 'text', text: 'nothing more to say', thought: true }] as never);

const lookupCall = () =>
  complete('', { tool_calls: [{ name: 'lookup', args: { q: 'spec' }, id: 'call-1' }] });

class GeminiLikeModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];

  constructor(private readonly script: Script) {
    super({});
  }
  _llmType(): string {
    return 'scripted-gemini-like';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.calls.push([...messages]);
    if (messages[messages.length - 1]?.getType() === 'ai') throw geminiBadRequest();
    const reply = this.script(this.calls.length, messages);
    if (reply instanceof Error) throw reply;
    return { generations: [{ message: reply, text: '' }] };
  }

  /**
   * Streams the way Vertex was measured to: the content first, and the finish reason — when there is
   * one — on a final chunk of its own. A cut reply is simply a stream that never sends that chunk.
   * Used whenever the graph streams (a messages-mode handler is attached); `invoke` uses `_generate`.
   */
  async *_streamResponseChunks(messages: BaseMessage[]) {
    const reply = (await this._generate(messages)).generations[0].message as AIMessage;
    const id = `run-scripted-${this.calls.length}`;
    yield new ChatGenerationChunk({
      text: '',
      message: new AIMessageChunk({
        id,
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
        message: new AIMessageChunk({ id, content: '', additional_kwargs: { finishReason } }),
      });
    }
  }

  requestTails(): string[] {
    return this.calls.map((c) => c[c.length - 1]?.getType() ?? 'none');
  }
}

const lookupTool = () =>
  tool(async () => 'LOOKED-UP', {
    name: 'lookup',
    description: 'Look something up.',
    schema: z.object({ q: z.string() }),
  });

/** A tool round, then a cut reply, then the retry answers. */
const cutThenRecovered: Script = (call) =>
  call === 1 ? lookupCall() : call === 2 ? cut() : complete('the recovered review');

/** A tool round, then a cut reply, and the retry is cut too. */
const cutTwice: Script = (call) => (call === 1 ? lookupCall() : cut());

/** A tool round, then a complete reply with no answer text. */
const completeEmptyAfterTool: Script = (call) => (call === 1 ? lookupCall() : completeEmpty());

type Path = 'streaming' | 'non-streaming' | 'events';
const PATHS: readonly Path[] = ['streaming', 'non-streaming', 'events'];

describe('[[EXT-204]] isCutModelReply — the retry condition', () => {
  it('is true for the measured shape: thought parts only, no tool call, no finish reason', () => {
    expect(isCutModelReply(cut())).toBe(true);
  });

  it('is true for a reply with no content at all and no finish reason', () => {
    expect(isCutModelReply(new AIMessage({ content: '' }))).toBe(true);
  });

  it('is false for a complete empty reply that carries a finish reason, in every key the reader knows', () => {
    expect(isCutModelReply(completeEmpty())).toBe(false);
    expect(
      isCutModelReply(new AIMessage({ content: '', response_metadata: { finish_reason: 'stop' } }))
    ).toBe(false);
    expect(
      isCutModelReply(
        new AIMessage({ content: '', response_metadata: { stop_reason: 'end_turn' } })
      )
    ).toBe(false);
    expect(
      isCutModelReply(new AIMessage({ content: '', response_metadata: { done_reason: 'stop' } }))
    ).toBe(false);
  });

  it('is false when the reply carries answer text, even with no finish reason', () => {
    expect(isCutModelReply(new AIMessage({ content: 'an answer' }))).toBe(false);
  });

  it('is false when the reply carries a tool call, even with no finish reason', () => {
    expect(
      isCutModelReply(
        new AIMessage({ content: '', tool_calls: [{ name: 'lookup', args: {}, id: 'c' }] })
      )
    ).toBe(false);
  });

  it('is false for anything that is not an AI message', () => {
    expect(isCutModelReply(new HumanMessage(''))).toBe(false);
    expect(isCutModelReply(undefined)).toBe(false);
  });
});

describe('[[EXT-204]] the middleware on its own', () => {
  const wrap = (onCut?: (reason: unknown) => void): ((request: any, handler: any) => any) =>
    (createCutStreamRetryMiddleware(onCut as never) as any).wrapModelCall;

  it('does not retry a cut reply when the call was aborted: Esc is the user’s decision', async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = vi.fn(async () => cut());

    const reply = await wrap()({ runtime: { signal: controller.signal } }, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(isCutModelReply(reply)).toBe(true);
  });

  it('records the `stream_cut` reason through its callback before it throws on a second cut', async () => {
    const onCut = vi.fn();
    const handler = vi.fn(async () => cut());

    await expect(wrap(onCut)({ runtime: {} }, handler)).rejects.toMatchObject({
      name: 'ModelStreamCutError',
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(onCut).toHaveBeenCalledTimes(1);
    expect(onCut.mock.calls[0][0]).toMatchObject({
      category: 'stream_cut',
      site: 'middleware.stream-cut-retry',
    });
  });

  it('takes the inner layer’s MiddlewareError off a provider error, so it is wrapped once, not twice', async () => {
    const provider = new Error('provider said no');
    const handler = vi.fn(async () => {
      throw MiddlewareError.wrap(provider, 'Inner');
    });

    await expect(wrap()({ runtime: {} }, handler)).rejects.toBe(provider);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('[[EXT-204]] a cut reply is retried once inside the model call', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  type Runner = InstanceType<typeof GthAgentRunner>;

  const projectDir = mkdtempSync(join(tmpdir(), 'gth-ext204-spec-'));
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => setProjectDir(priorProjectDir));
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  async function runnerFor(model: GeminiLikeModel, path: Path): Promise<Runner> {
    const runner = new GthAgentRunner(vi.fn());
    const config = {
      streamOutput: path !== 'non-streaming',
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
    await runner.init('ask', config, new MemorySaver());
    return runner;
  }

  /** Run one turn on the given path; hand back its answer text and the error it ended with. */
  async function turn(runner: Runner, path: Path): Promise<{ text: string; error: unknown }> {
    const input = [new HumanMessage('review the change')];
    try {
      if (path !== 'events') return { text: await runner.processMessages(input), error: null };
      let text = '';
      for await (const event of runner.processMessagesWithEvents(input)) {
        const e = event as AgentStreamEvent & { delta?: string };
        if (e.type === 'text' && typeof e.delta === 'string') text += e.delta;
      }
      return { text, error: null };
    } catch (error) {
      return { text: '', error };
    }
  }

  async function threadOf(runner: Runner): Promise<BaseMessage[]> {
    const agent = runner.getAgent() as unknown as {
      getConversationMessages(config: unknown): Promise<BaseMessage[]>;
    };
    const runConfig = (runner as unknown as { runConfig: unknown }).runConfig;
    return agent.getConversationMessages(runConfig);
  }

  for (const path of PATHS) {
    describe(`on the ${path} path`, () => {
      it('recovers with exactly one extra model call, on a request that ends with the tool result', async () => {
        const model = new GeminiLikeModel(cutThenRecovered);
        const runner = await runnerFor(model, path);

        const { text, error } = await turn(runner, path);

        expect(error).toBeNull();
        expect(text).toContain('the recovered review');
        // One call for the tool round, the cut one, and exactly one retry — sent the same
        // request, which ends with the tool result.
        expect(model.calls).toHaveLength(3);
        expect(model.requestTails()).toEqual(['human', 'tool', 'tool']);
        expect(model.calls[2]).toEqual(model.calls[1]);
        expect(runner.getTerminationReason()).toMatchObject({ category: 'completed' });

        // The cut reply never reached the thread: it ends with the recovered answer, and no
        // thought-only message sits anywhere in it.
        const thread = await threadOf(runner);
        const last = thread[thread.length - 1];
        expect(last?.getType()).toBe('ai');
        expect(last?.text).toContain('the recovered review');
        expect(thread.filter((m) => isCutModelReply(m))).toEqual([]);
      });

      it('does not retry a complete reply that says STOP with no answer text', async () => {
        const model = new GeminiLikeModel(completeEmptyAfterTool);
        const runner = await runnerFor(model, path);

        await turn(runner, path);

        // Two calls only: the model's own empty decision is not second-guessed, and the runner's
        // existing empty-turn handling still owns it.
        expect(model.calls).toHaveLength(2);
        expect(model.requestTails()).toEqual(['human', 'tool']);
        expect(runner.getTerminationReason()).toMatchObject({ category: 'empty_response' });
      });

      it('ends the turn as `stream_cut` when the retry is cut too, and makes no third attempt', async () => {
        const model = new GeminiLikeModel(cutTwice);
        const runner = await runnerFor(model, path);

        const { error } = await turn(runner, path);

        expect(model.calls).toHaveLength(3);
        expect(model.requestTails()).toEqual(['human', 'tool', 'tool']);
        // The stated reason on BOTH carriers, structurally: the runner's reading and the error.
        expect(runner.getTerminationReason()).toMatchObject({
          category: 'stream_cut',
          site: 'middleware.stream-cut-retry',
        });
        expect(error).toBeInstanceOf(Error);
        expect(terminationReasonOf(error)).toMatchObject({
          category: 'stream_cut',
          site: 'middleware.stream-cut-retry',
        });
        expect((error as Error).message).not.toContain(MODEL_TURN_MESSAGE);
      });
    });
  }

  it('records the cut message in the finish-reason log as absent, then the retry’s own reason', async () => {
    const model = new GeminiLikeModel(cutThenRecovered);
    const runner = await runnerFor(model, 'streaming');

    await turn(runner, 'streaming');

    const tokens = runner.getFinishReasonObservations().map((o) => o.token);
    expect(tokens).toEqual(['stop', null, 'stop']);
  });
});
