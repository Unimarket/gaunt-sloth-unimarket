/**
 * [[EXT-203]] — no request the runner makes may end with the model's own turn, and a run that ends
 * on a provider error inside the approval drain reports that error, not the drain's bound.
 *
 * Driven through a REAL `GthAgentRunner` over a REAL `createAgent` graph with the approval
 * middleware installed (`exec` answers approvals, so every tool call suspends and is resumed by the
 * runner's drain loop), on both a `MemorySaver` and the durable sqlite saver the single-shot path
 * uses. The model is scripted and records every message list it is handed, and — like Gemini — it
 * rejects a request whose last message is an AI message with a 400. The assertions are on what the
 * model RECEIVED, so a runner that returned the right text from some other route cannot pass them.
 *
 * The two shapes are the two ways into the empty-stream fallback that sent such a request:
 * - the run-2 shape: a tool call that fails, then a reply with no answer text (here a thought-only
 *   reply), which leaves the thread ending with that empty AI message;
 * - the exhausted drain: tool call after tool call until the drain loop's bound, which leaves the
 *   graph suspended on a tool-calling AI message. Both of the CFG-84 lane's live `gth exec` runs
 *   on Gemini ended this way: their reason code was the drain bound, which only this shape notes.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseCheckpointSaver, MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { AgentStreamEvent } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';

vi.mock('#src/core/shell/rater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/core/shell/rater.js')>()),
  rateShellCommand: vi.fn(),
  mapVerdictToAction: vi.fn(),
}));

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

/** The body Gemini returns for a request whose last content is a model turn. */
const MODEL_TURN_MESSAGE = 'Requests ending with a model turn are not supported.';

/** A 400 in the shape `@langchain/google` raises it: a `RequestError` carrying the status. */
function geminiBadRequest(): Error {
  const error = new Error(MODEL_TURN_MESSAGE) as Error & { statusCode: number; data: unknown };
  error.name = 'RequestError';
  error.statusCode = 400;
  error.data = { error: { code: 400, message: MODEL_TURN_MESSAGE, status: 'INVALID_ARGUMENT' } };
  return error;
}

/** What the model does on its Nth call (1-based), given the messages it was handed. */
type Script = (call: number, messages: BaseMessage[]) => AIMessage | Error;

/** A reply carrying only a thought part: no answer text reaches the runner. */
const thoughtOnly = (extra: Partial<ConstructorParameters<typeof AIMessage>[0] & object> = {}) =>
  new AIMessage({
    content: [{ type: 'text', text: 'considering the result', thought: true }] as never,
    ...extra,
  });

const shellCall = (call: number, command: string) =>
  thoughtOnly({
    tool_calls: [{ name: 'run_shell_command', args: { command }, id: `call-${call}` }],
  });

class GeminiLikeModel extends BaseChatModel {
  /** Every message list the model was handed, in call order. */
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
    // Gemini's own rule, enforced here so a regression fails the way it failed live.
    if (messages[messages.length - 1]?.getType() === 'ai') throw geminiBadRequest();
    const reply = this.script(this.calls.length, messages);
    if (reply instanceof Error) throw reply;
    return { generations: [{ message: reply, text: '' }] };
  }

  /** The message type each request ended with, e.g. `['human', 'tool']`. */
  requestTails(): string[] {
    return this.calls.map((c) => c[c.length - 1]?.getType() ?? 'none');
  }
}

/**
 * The shell tool. A command starting with `fail` exits 1 the way `GthDevToolkit` reports it (a
 * `ShellCommandFailedError`, softened into an error ToolMessage by the agent); anything else runs.
 */
const shellTool = () =>
  tool(
    async (args: { command: string }) => {
      if (!args.command.startsWith('fail')) return `ran ${args.command}`;
      const error = new Error('exit 1') as Error & Record<string, unknown>;
      error.name = 'ShellCommandFailedError';
      error.output = `Command '${args.command}' exited with code 1`;
      error.command = args.command;
      error.toolName = 'run_shell_command';
      error.exitCode = 1;
      throw error;
    },
    {
      name: 'run_shell_command',
      description: 'Run a shell command.',
      schema: z.object({ command: z.string() }),
    }
  );

/**
 * The run-2 shape: a failing tool call, then a reply with no answer text.
 *
 * [[EXT-204]] — the empty reply is a COMPLETE one: it carries Gemini's finish reason, in the key
 * Vertex sends it under. A reply with no finish reason is a stream cut off before it finished, and
 * that one is now retried inside the model call and never reaches the runner's empty-stream site
 * (`cutStreamRetry.ext204.spec.ts` covers it). A complete empty reply is the model's own decision,
 * is not retried, and still ends here, which is what these cells pin.
 */
const run2Shape: Script = (call) =>
  call === 1
    ? shellCall(call, 'fail pnpm exec vitest run quotaCooldown.spec.ts')
    : thoughtOnly({ additional_kwargs: { finishReason: 'STOP' } });

/** Tool call after tool call, never an answer: the drain loop's bound is what ends the turn. */
const endlessTools: Script = (call) => shellCall(call, `echo round ${call}`);

/** A real graph runs once per call, so a hundred rounds take real time on a slow CI runner. */
const REAL_AGENT_TIMEOUT_MS = 60_000;

type SaverKind = 'memory' | 'sqlite';
const SAVERS: readonly SaverKind[] = ['memory', 'sqlite'];

describe('[[EXT-203]] no request ends with a model turn, and the run ends with its real reason', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  type Runner = InstanceType<typeof GthAgentRunner>;

  // EXT-71 — clamp the anchor the persisted grant store resolves from.
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-ext203-spec-'));
  let priorProjectDir: string | undefined;
  let dir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gth-ext203-db-'));
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  // win32 refuses to delete a directory holding an open database file, so close every saver first.
  let openSavers: { close(): void }[] = [];

  afterEach(() => {
    for (const saver of openSavers) saver.close();
    openSavers = [];
    rmSync(dir, { recursive: true, force: true });
    setProjectDir(priorProjectDir);
  });

  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  function saverFor(kind: SaverKind): BaseCheckpointSaver {
    if (kind === 'memory') return new MemorySaver();
    const saver = openCheckpointSaver(join(dir, 'history.db'));
    if (!saver) throw new Error('the sqlite checkpoint saver did not open');
    openSavers.push(saver);
    return saver;
  }

  async function runnerFor(
    model: GeminiLikeModel,
    saver: SaverKind,
    streamOutput: boolean
  ): Promise<Runner> {
    const runner = new GthAgentRunner(vi.fn());
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
      devTools: { run_shell_command: { enabled: true } },
      tools: [shellTool()],
      // Every call still suspends on the approval interrupt; `bypass` answers it with no rating.
      approvals: 'bypass',
    } as unknown as GthConfig;
    await runner.init('exec', config, saverFor(saver));
    return runner;
  }

  /** Run a string-path turn and hand back the error it ended with, or `null`. */
  async function turnError(runner: Runner): Promise<Error | null> {
    try {
      await runner.processMessages([new HumanMessage('fix the failing spec')]);
      return null;
    } catch (error) {
      return error as Error;
    }
  }

  async function eventTurn(
    runner: Runner
  ): Promise<{ events: AgentStreamEvent[]; error: unknown }> {
    const events: AgentStreamEvent[] = [];
    try {
      for await (const event of runner.processMessagesWithEvents([
        new HumanMessage('fix the failing spec'),
      ])) {
        events.push(event);
      }
      return { events, error: null };
    } catch (error) {
      return { events, error };
    }
  }

  for (const saver of SAVERS) {
    describe(`on the ${saver} saver`, () => {
      describe('the run-2 shape: a failing tool call, then a reply with no answer text', () => {
        it(
          'string path, streaming: never sends a history ending with the model turn',
          async () => {
            const model = new GeminiLikeModel(run2Shape);
            const runner = await runnerFor(model, saver, true);

            const error = await turnError(runner);

            expect(model.requestTails()).toEqual(['human', 'tool']);
            expect(error?.message).not.toContain(MODEL_TURN_MESSAGE);
            expect(error?.message).toMatch(/empty response after tool execution/);
            expect(runner.getTerminationReason()).toMatchObject({
              site: 'runner.empty-stream',
              category: 'empty_response',
            });
          },
          REAL_AGENT_TIMEOUT_MS
        );

        it(
          'string path, non-streaming: the same history, and the same honest ending',
          async () => {
            const model = new GeminiLikeModel(run2Shape);
            const runner = await runnerFor(model, saver, false);

            const error = await turnError(runner);

            expect(model.requestTails()).toEqual(['human', 'tool']);
            expect(runner.getTerminationReason()).toMatchObject({ category: 'empty_response' });
            expect(error?.message).not.toContain(MODEL_TURN_MESSAGE);
          },
          REAL_AGENT_TIMEOUT_MS
        );

        it(
          'typed-event path: never sends a history ending with the model turn',
          async () => {
            const model = new GeminiLikeModel(run2Shape);
            const runner = await runnerFor(model, saver, true);

            const { error } = await eventTurn(runner);

            expect(error).toBeNull();
            expect(model.requestTails()).toEqual(['human', 'tool']);
            expect(runner.getTerminationReason()).toMatchObject({
              site: 'runner.events-empty',
              category: 'empty_response',
            });
          },
          REAL_AGENT_TIMEOUT_MS
        );

        /**
         * The drain that finishes normally must not be reported as the bound: the guard is noted
         * only when the loop really ran out of rounds.
         */
        it(
          'a drain that ends with an answer reports `completed`, not the drain bound',
          async () => {
            const model = new GeminiLikeModel((call) =>
              call === 1 ? shellCall(call, 'fail pnpm run lint') : new AIMessage('lint is red')
            );
            const runner = await runnerFor(model, saver, true);

            await expect(
              runner.processMessages([new HumanMessage('fix the failing spec')])
            ).resolves.toBe('lint is red');

            expect(runner.getTerminationReason()).toMatchObject({
              site: 'runner.completed',
              category: 'completed',
            });
          },
          REAL_AGENT_TIMEOUT_MS
        );
      });

      describe('the exhausted drain: a tool call every round until the bound', () => {
        for (const streamOutput of [true, false]) {
          it(
            `string path, ${streamOutput ? 'streaming' : 'non-streaming'}: ends on the bound and sends no model-turn-final request`,
            async () => {
              const model = new GeminiLikeModel(endlessTools);
              const runner = await runnerFor(model, saver, streamOutput);

              const error = await turnError(runner);

              // The first call plus one per resume round, and nothing after the bound.
              expect(model.calls).toHaveLength(101);
              expect(model.requestTails().filter((t) => t === 'ai')).toEqual([]);
              expect(error?.message).toContain(
                'Stopped after 100 rounds of tool approvals in one turn'
              );
              expect(error?.message).not.toContain(MODEL_TURN_MESSAGE);
              expect(runner.getTerminationReason()).toMatchObject({
                site: 'runner.interrupt-guard-exhausted',
                category: 'interrupt_drain_guard',
              });
            },
            REAL_AGENT_TIMEOUT_MS
          );
        }

        it(
          'typed-event path: ends on the bound and sends no model-turn-final request',
          async () => {
            const model = new GeminiLikeModel(endlessTools);
            const runner = await runnerFor(model, saver, true);

            await eventTurn(runner);

            expect(model.calls).toHaveLength(101);
            expect(model.requestTails().filter((t) => t === 'ai')).toEqual([]);
            expect(runner.getTerminationReason()).toMatchObject({
              site: 'runner.events-interrupt-guard-exhausted',
              category: 'interrupt_drain_guard',
            });
          },
          REAL_AGENT_TIMEOUT_MS
        );
      });

      describe('a provider error inside the approval-drain resume', () => {
        /** The call after the tool result is the one the resume makes, and it is rejected. */
        const rejectedInResume: Script = (call) =>
          call === 1 ? shellCall(call, 'fail pnpm run build') : geminiBadRequest();

        for (const streamOutput of [true, false]) {
          it(
            `string path, ${streamOutput ? 'streaming' : 'non-streaming'}: ends with the provider's reason`,
            async () => {
              const model = new GeminiLikeModel(rejectedInResume);
              const runner = await runnerFor(model, saver, streamOutput);

              const error = await turnError(runner);

              expect(model.calls).toHaveLength(2);
              expect(error?.message).toContain(MODEL_TURN_MESSAGE);
              // The provider's failure, classified where the runner caught it. Only the site and
              // source are pinned: by the time the error reaches the runner it no longer carries
              // the 400 status, so its category is not what this spec is about.
              expect(runner.getTerminationReason()).toMatchObject({
                site: streamOutput ? 'runner.stream-error' : 'runner.turn-error',
                source: 'exception',
              });
              expect(runner.getTerminationReason()?.category).not.toBe('interrupt_drain_guard');
            },
            REAL_AGENT_TIMEOUT_MS
          );
        }

        it(
          "typed-event path: ends with the provider's reason",
          async () => {
            const model = new GeminiLikeModel(rejectedInResume);
            const runner = await runnerFor(model, saver, true);

            const { error } = await eventTurn(runner);

            expect(model.calls).toHaveLength(2);
            expect((error as Error | null)?.message).toContain(MODEL_TURN_MESSAGE);
            expect(runner.getTerminationReason()).toMatchObject({
              site: 'runner.events-error',
              source: 'exception',
            });
            expect(runner.getTerminationReason()?.category).not.toBe('interrupt_drain_guard');
          },
          REAL_AGENT_TIMEOUT_MS
        );
      });
    });
  }
});
