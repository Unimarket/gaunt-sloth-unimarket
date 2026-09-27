/**
 * GS2-106 — a single-shot run CONTINUING a recorded conversation (`runSingleShot`'s `resume`
 * option), on a REAL lean agent over a REAL `node:sqlite` file.
 *
 * The first cell is the one a transcript replay cannot pass: the first run gets a secret only a tool
 * knows and does not say it; the resumed run must answer with the secret without calling the tool
 * again. The rest pins what a resumed turn does to the record (one row, two turns, the same run id,
 * the command column unchanged), the degrade path on a resumed run, a store that will not open, a
 * row written before run ids existed, and the fan-out origin.
 *
 * Every path here uses a temp `history.dbPath`. Nothing resolves a path from `HOME`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import type { AgentResolvers } from '#src/core/types.js';
import { peekProjectDir, setProjectDir } from '#src/utils/systemUtils.js';
import * as consoleUtils from '#src/utils/consoleUtils.js';

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
    displayNotice: vi.fn(),
    displayToolIndication: vi.fn(),
    defaultStatusCallback: vi.fn(),
  };
});

/** The two faults a spec can inject into the saver `runSingleShot` opens. */
const faults = vi.hoisted(() => ({ failOpen: false, failWritesAfterFirst: false }));
vi.mock('#src/history/checkpointSaver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/history/checkpointSaver.js')>();
  return {
    ...actual,
    openCheckpointSaver: (...args: Parameters<typeof actual.openCheckpointSaver>) => {
      if (faults.failOpen) return null;
      const saver = actual.openCheckpointSaver(...args);
      if (saver && faults.failWritesAfterFirst) {
        const { db } = saver as unknown as { db: DatabaseSync };
        const put = saver.put.bind(saver);
        let puts = 0;
        saver.put = async (...putArgs: Parameters<typeof put>) => {
          const out = await put(...putArgs);
          if (++puts === 1) db.exec('PRAGMA query_only = 1');
          return out;
        };
      }
      return saver;
    },
  };
});

/** The value only the tool knows. The first run's answer does not contain it. */
const SECRET = 'ORBIT-4417';
const FIRST_ANSWER = 'looked it up';
const FOLLOW_UP = 'what was the code?';

/** How many times the model was called; a refused resume must not call it at all. */
let modelCalls = 0;

/**
 * The first run: call the tool, then answer WITHOUT the secret. A follow-up (a second human
 * message): answer from the tool result already in the conversation when there is one, and
 * otherwise go and call the tool — which is exactly what a replayed transcript would force.
 */
class RecallModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-recall';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    modelCalls++;
    const humans = messages.filter((m) => HumanMessage.isInstance(m));
    const toolResult = messages.find((m) => ToolMessage.isInstance(m));
    let message: AIMessage;
    if (!toolResult) {
      message = new AIMessage({
        content: '',
        tool_calls: [{ name: 'lookup_code', args: {}, id: `call-${modelCalls}` }],
      });
    } else if (humans.length >= 2) {
      message = new AIMessage(`The code was ${String(toolResult.content)}`);
    } else {
      message = new AIMessage(FIRST_ANSWER);
    }
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

const REAL_AGENT_TIMEOUT_MS = 30_000;

describe('GS2-106 — a single-shot run resumes a recorded conversation', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'gth-singleshot-resume-project-'));
  let priorProjectDir: string | undefined;
  let dir: string;
  let dbPath: string;
  let toolCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    faults.failOpen = false;
    faults.failWritesAfterFirst = false;
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
    dir = mkdtempSync(join(tmpdir(), 'gsloth-singleshot-resume-'));
    dbPath = join(dir, 'history.db');
    toolCalls = 0;
    modelCalls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setProjectDir(priorProjectDir);
  });

  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  const resolvers = (): AgentResolvers =>
    ({
      resolveTools: vi.fn().mockResolvedValue([
        tool(
          async () => {
            toolCalls++;
            return SECRET;
          },
          { name: 'lookup_code', description: 'Look up the code.', schema: z.object({}) }
        ),
      ]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    }) as unknown as AgentResolvers;

  const config = (over: Record<string, unknown> = {}): GthConfig =>
    ({
      llm: new RecallModel(),
      contentProvider: 'file',
      requirementsProvider: 'file',
      projectGuidelines: '.gsloth.guidelines.md',
      projectReviewInstructions: '.gsloth.review.md',
      commands: {},
      filesystem: 'none',
      useColour: false,
      streamOutput: true,
      writeOutputToFile: false,
      writeBinaryOutputsToFile: false,
      streamSessionInferenceLog: false,
      canInterruptInferenceWithEsc: false,
      includeCurrentDateAfterGuidelines: true,
      approvals: 'bypass',
      modelDisplayName: 'scripted-recall',
      history: { dbPath },
      ...over,
    }) as unknown as GthConfig;

  type Options = Parameters<typeof import('#src/runtime/singleShot.js').runSingleShot>[7];
  const run = async (
    prompt: string,
    command: 'ask' | 'exec' = 'ask',
    options?: Options,
    over?: Record<string, unknown>
  ) => {
    const { runSingleShot } = await import('#src/runtime/singleShot.js');
    return runSingleShot(
      'SINGLE-SHOT',
      '',
      prompt,
      config(over),
      resolvers(),
      command,
      undefined,
      options
    );
  };

  const sql = <T = Record<string, unknown>>(query: string, ...params: (string | number)[]): T[] => {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare(query).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  const row = (id: number) =>
    sql(`SELECT thread_id, run_id, command, origin FROM conversations WHERE id = ?`, id)[0];

  /** What a resume seam hands the runtime once its checks have passed: the row and its thread. */
  const resumeOf = (id: number) => ({ conversationId: id, threadId: String(row(id).thread_id) });

  it(
    'ACCEPTANCE: the resumed turn answers from the first run’s TOOL RESULT without calling the tool again',
    async () => {
      const first = await run('look up the code');
      expect(first.ok).toBe(true);
      // The first answer does not carry the secret, so nothing but the stored tool result can.
      expect(first.answer).toBe(FIRST_ANSWER);
      expect(first.answer).not.toContain(SECRET);
      expect(toolCalls).toBe(1);

      const resumed = await run(FOLLOW_UP, 'ask', {
        resume: resumeOf(first.conversation!.conversationId),
      });

      expect(resumed.ok).toBe(true);
      expect(resumed.answer).toBe(`The code was ${SECRET}`);
      // Exactly once across both runs: the resumed run re-entered the checkpoint.
      expect(toolCalls).toBe(1);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'ACCEPTANCE: after a resume the conversation has two turns, one row and the same run id, and its command is unchanged — even resumed as exec',
    async () => {
      const first = await run('look up the code');
      const { conversationId, runId } = first.conversation!;

      const resumed = await run(FOLLOW_UP, 'exec', { resume: resumeOf(conversationId) });

      expect(resumed.conversation).toEqual({ conversationId, runId });
      expect(sql(`SELECT id FROM conversations`)).toEqual([{ id: conversationId }]);
      expect(row(conversationId)).toMatchObject({ run_id: runId, command: 'ask', origin: null });
      const turns = sql<{ prompt: string; command: string }>(
        `SELECT prompt, command FROM sessions WHERE conversation_id = ? ORDER BY id`,
        conversationId
      );
      expect(turns.map((t) => t.prompt)).toEqual(['look up the code', FOLLOW_UP]);
      // Each turn says which command ran it; the conversation keeps what it was recorded as.
      expect(turns.map((t) => t.command)).toEqual(['ask', 'exec']);
      // And the new turn's state landed under the conversation's own thread.
      const threads = sql<{ thread_id: string }>(`SELECT DISTINCT thread_id FROM checkpoints`);
      expect(threads).toEqual([{ thread_id: String(row(conversationId).thread_id) }]);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'ACCEPTANCE (degrade): a checkpoint write failing during a resumed run cuts the link, and the run still finishes with its answer',
    async () => {
      const first = await run('look up the code');
      const { conversationId } = first.conversation!;
      vi.clearAllMocks();

      faults.failWritesAfterFirst = true;
      const resumed = await run(FOLLOW_UP, 'ask', { resume: resumeOf(conversationId) });

      expect.soft(vi.mocked(consoleUtils.displayError).mock.calls).toEqual([]);
      expect.soft(resumed.ok).toBe(true);
      expect.soft(resumed.answer).toBe(`The code was ${SECRET}`);
      expect(consoleUtils.displayWarning).toHaveBeenCalledTimes(1);
      expect(vi.mocked(consoleUtils.displayWarning).mock.calls[0][0]).toContain('resumable');
      // The link is cut on the row the run continued, and the turn is still recorded under it.
      expect(row(conversationId).thread_id).toBeNull();
      expect(resumed.conversation?.conversationId).toBe(conversationId);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'a store that will not open when the resumed run starts refuses it, and nothing runs',
    async () => {
      const first = await run('look up the code');
      const target = resumeOf(first.conversation!.conversationId);
      const callsBefore = modelCalls;
      vi.clearAllMocks();

      faults.failOpen = true;
      const resumed = await run(FOLLOW_UP, 'ask', { resume: target });

      expect(resumed.ok).toBe(false);
      expect(resumed.answer).toBe('');
      expect(modelCalls).toBe(callsBefore);
      expect(vi.mocked(consoleUtils.displayError).mock.calls[0][0]).toContain(
        `Conversation #${target.conversationId} was not resumed`
      );
      // No turn was recorded against it.
      expect(sql(`SELECT id FROM sessions`)).toHaveLength(1);
    },
    REAL_AGENT_TIMEOUT_MS
  );

  it(
    'a row written before run ids existed resumes by its integer, and no run id is minted for it',
    async () => {
      const first = await run('look up the code');
      const { conversationId } = first.conversation!;
      // What a pre-migration row looks like: the same row, with no run id.
      const db = new DatabaseSync(dbPath);
      db.prepare(`UPDATE conversations SET run_id = NULL WHERE id = ?`).run(conversationId);
      db.close();

      const resumed = await run(FOLLOW_UP, 'ask', { resume: resumeOf(conversationId) });

      expect(resumed.answer).toBe(`The code was ${SECRET}`);
      expect(resumed.conversation).toEqual({ conversationId, runId: null });
      expect(row(conversationId).run_id).toBeNull();
    },
    REAL_AGENT_TIMEOUT_MS
  );

  describe('the continue hint (output.resumeHint)', () => {
    const HINT = { announceResumeHint: true } as const;
    const notices = () =>
      vi.mocked(consoleUtils.displayNotice).mock.calls.map(([title, lines]) => ({
        title,
        lines: [...lines],
      }));
    const hintsOf = () => notices().filter((n) => n.title.startsWith('To continue'));
    const noHintsOf = () => notices().filter((n) => n.title.startsWith('No resume hint'));

    it(
      'ACCEPTANCE: omitted means compact — one line naming the run id, and that id resumes the conversation',
      async () => {
        const first = await run('look up the code', 'ask', HINT);
        const { conversationId, runId } = first.conversation!;
        expect(runId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.resumability).toEqual({ resumable: true });
        expect(hintsOf()).toEqual([
          {
            title: `To continue this conversation: gth ask --resume ${runId} "…"`,
            lines: [],
          },
        ]);
        vi.clearAllMocks();

        // The id the hint named, fed back: the same conversation, and it prints the SAME run id.
        const resumed = await run(FOLLOW_UP, 'ask', {
          ...HINT,
          resume: resumeOf(conversationId),
        });
        expect(resumed.answer).toBe(`The code was ${SECRET}`);
        expect(resumed.conversation).toEqual({ conversationId, runId });
        expect(hintsOf().map((n) => n.title)).toEqual([
          `To continue this conversation: gth ask --resume ${runId} "…"`,
        ]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'exec names exec and -m',
      async () => {
        const first = await run('look up the code', 'exec', HINT);
        expect(hintsOf().map((n) => n.title)).toEqual([
          `To continue this conversation: gth exec --resume ${first.conversation!.runId} -m "…"`,
        ]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'compact, set explicitly, is the same one line',
      async () => {
        const first = await run('look up the code', 'ask', HINT, {
          output: { resumeHint: 'compact' },
        });
        expect(hintsOf()).toEqual([
          {
            title: `To continue this conversation: gth ask --resume ${first.conversation!.runId} "…"`,
            lines: [],
          },
        ]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'none prints nothing, though the run is resumable',
      async () => {
        const first = await run('look up the code', 'ask', HINT, {
          output: { resumeHint: 'none' },
        });
        expect(first.resumability).toEqual({ resumable: true });
        expect(notices()).toEqual([]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'debug adds the integer id and the history file',
      async () => {
        const first = await run('look up the code', 'ask', HINT, {
          output: { resumeHint: 'debug' },
        });
        const { conversationId, runId } = first.conversation!;
        expect(hintsOf()).toEqual([
          {
            title: `To continue this conversation: gth ask --resume ${runId} "…"`,
            lines: [`Conversation #${conversationId}.`, `History file: ${dbPath}`],
          },
        ]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'ACCEPTANCE: with history off the run prints no hint; debug says it was not recorded',
      async () => {
        const off = await run('look up the code', 'ask', HINT, {
          history: { enabled: false, dbPath },
        });
        expect(off.ok).toBe(true);
        expect(off.conversation).toBeUndefined();
        expect(off.resumability).toEqual({ resumable: false, reason: 'history-off' });
        expect(notices()).toEqual([]);
        vi.clearAllMocks();

        await run('look up the code', 'ask', HINT, {
          history: { enabled: false, dbPath },
          output: { resumeHint: 'debug' },
        });
        expect(hintsOf()).toEqual([]);
        expect(noHintsOf()).toHaveLength(1);
        expect(noHintsOf()[0].title).toContain('history is off');
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'a caller that did not ask — every harness — prints nothing and gets no resumability, whatever the rung',
      async () => {
        const cell = await run(
          'look up the code',
          'exec',
          { displayCommand: 'batch', origin: 'batch' },
          { output: { resumeHint: 'debug' } }
        );
        expect(cell.conversation).toBeDefined();
        expect(cell.resumability).toBeUndefined();
        expect(notices()).toEqual([]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'ACCEPTANCE (degrade): a resumed run whose link was cut prints no hint under compact, and the reason under debug',
      async () => {
        const first = await run('look up the code');
        const { conversationId } = first.conversation!;
        vi.clearAllMocks();

        faults.failWritesAfterFirst = true;
        const cut = await run(FOLLOW_UP, 'ask', { ...HINT, resume: resumeOf(conversationId) });
        expect(cut.answer).toBe(`The code was ${SECRET}`);
        expect(cut.resumability).toEqual({ resumable: false, reason: 'link-cut' });
        expect(notices()).toEqual([]);

        // The same failure under debug, on a fresh conversation (the first one is now unlinked).
        const second = await run('look up the code');
        vi.clearAllMocks();
        await run(
          FOLLOW_UP,
          'ask',
          { ...HINT, resume: resumeOf(second.conversation!.conversationId) },
          { output: { resumeHint: 'debug' } }
        );
        expect(hintsOf()).toEqual([]);
        expect(noHintsOf()).toHaveLength(1);
        expect(noHintsOf()[0].title).toContain('a checkpoint write failed during the run');
        expect(noHintsOf()[0].lines).toEqual([
          `Conversation #${second.conversation!.conversationId}.`,
          `History file: ${dbPath}`,
        ]);
      },
      REAL_AGENT_TIMEOUT_MS
    );

    it(
      'a row that predates run ids falls back to its integer, and debug says why — no run id is minted',
      async () => {
        const first = await run('look up the code');
        const { conversationId } = first.conversation!;
        const db = new DatabaseSync(dbPath);
        db.prepare(`UPDATE conversations SET run_id = NULL WHERE id = ?`).run(conversationId);
        db.close();

        await run(FOLLOW_UP, 'ask', { ...HINT, resume: resumeOf(conversationId) });
        expect(hintsOf().map((n) => n.title)).toEqual([
          `To continue this conversation: gth ask --resume ${conversationId} "…"`,
        ]);
        vi.clearAllMocks();

        await run(
          'and again',
          'ask',
          { ...HINT, resume: resumeOf(conversationId) },
          { output: { resumeHint: 'debug' } }
        );
        const [hint] = hintsOf();
        expect(hint.title).toBe(
          `To continue this conversation: gth ask --resume ${conversationId} "…"`
        );
        expect(hint.lines[2]).toContain('predates run ids');
        expect(row(conversationId).run_id).toBeNull();
      },
      REAL_AGENT_TIMEOUT_MS
    );
  });

  it(
    'a fan-out caller’s origin is recorded on the conversation; a direct run records none',
    async () => {
      const cell = await run('look up the code', 'exec', { origin: 'batch' });
      const direct = await run('look up the code', 'exec');
      expect(row(cell.conversation!.conversationId)).toMatchObject({
        command: 'exec',
        origin: 'batch',
      });
      expect(row(direct.conversation!.conversationId)).toMatchObject({
        command: 'exec',
        origin: null,
      });
    },
    REAL_AGENT_TIMEOUT_MS
  );
});
