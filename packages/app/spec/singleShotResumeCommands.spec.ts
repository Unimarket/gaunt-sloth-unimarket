/**
 * GS2-106 — `gth ask --resume` and `gth exec --resume -m`, through the commands' real bodies, the
 * real resume seam and the real `runSingleShot`, over a REAL history file. Only the config load, the
 * console, the exit status and the tool resolvers are faked, and the model is a stub.
 *
 * What is pinned here:
 * - an accepted cell per non-interactive column: an ask row resumed by `ask --resume`, and by
 *   `exec --resume -m`, recorded as one conversation;
 * - every refusal is loud, exits 1 and runs nothing — the model is never called and no turn is
 *   recorded: the matrix's refused cells, the thread-tail refusal, and `exec --resume`'s input rules;
 * - id resolution: an unknown integer, an unknown run id, a run id from ANOTHER database and a run id
 *   from a database since deleted and recreated each fail by name, and never resume the neighbour
 *   that sits at the same integer;
 * - REVISION 2: a stored grant is NOT in force on `ask --write --resume`, and is not written back.
 *
 * Every path is a temp file. Nothing resolves a path from `HOME`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Command } from 'commander';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';

const initConfigMock = vi.hoisted(() => vi.fn());
vi.mock('@gaunt-sloth/core/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/config.js')>()),
  initConfig: initConfigMock,
}));

const consoleMock = vi.hoisted(() => ({
  display: vi.fn(),
  displayInfo: vi.fn(),
  displayNotice: vi.fn(),
  displayWarning: vi.fn(),
  displayError: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  displayToolIndication: vi.fn(),
  defaultStatusCallback: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

const systemMock = vi.hoisted(() => ({ setExitCode: vi.fn(), getStringFromStdin: vi.fn() }));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  ...systemMock,
}));

vi.mock('@gaunt-sloth/core/utils/llmUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/llmUtils.js')>()),
  readBackstory: vi.fn(() => 'BACKSTORY'),
  readGuidelines: vi.fn(() => ''),
  readSystemPrompt: vi.fn(() => ''),
}));

vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({
  createResolvers: () => ({
    resolveTools: async () => [],
    resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    cleanupTools: async () => {},
  }),
}));

/** Every human message the model was shown, per call — what a resume re-entered is read off this. */
const modelSaw: string[][] = [];

class EchoModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-echo';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    const humans = messages.filter((m) => HumanMessage.isInstance(m)).map((m) => String(m.content));
    modelSaw.push(humans);
    const text = `answer ${modelSaw.length}`;
    return { generations: [{ message: new AIMessage(text), text }] };
  }
}

describe('GS2-106 — ask --resume and exec --resume -m', () => {
  const projectDir = mkdtempSync(resolve(tmpdir(), 'gsloth-ss-resume-project-'));
  let dir: string;
  let dbPath: string;
  let priorProjectDir: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    modelSaw.length = 0;
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-ss-resume-'));
    dbPath = resolve(dir, 'history.db');
    systemMock.getStringFromStdin.mockReturnValue('');
    initConfigMock.mockImplementation(async () => configAt(dbPath));
    const { peekProjectDir, setProjectDir } =
      await import('@gaunt-sloth/core/utils/systemUtils.js');
    priorProjectDir = peekProjectDir();
    setProjectDir(projectDir);
  });
  afterEach(async () => {
    const { setProjectDir } = await import('@gaunt-sloth/core/utils/systemUtils.js');
    setProjectDir(priorProjectDir);
    rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

  const configAt = (path: string) => ({
    llm: new EchoModel(),
    commands: {},
    filesystem: 'none',
    useColour: false,
    streamOutput: true,
    writeOutputToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    approvals: 'bypass',
    modelDisplayName: 'scripted-echo',
    history: { dbPath: path },
  });

  /** A fresh program per invocation, with both commands, as `cli.ts` builds it. */
  const gth = async (...args: string[]) => {
    const { askCommand } = await import('#src/commands/askCommand.js');
    const { execCommand } = await import('#src/commands/execCommand.js');
    const { resumeOption } = await import('#src/commands/resumeOption.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    program.addOption(resumeOption());
    askCommand(program, {});
    execCommand(program, {});
    await program.parseAsync(['node', 'gth', ...args]);
  };

  const sql = <T = Record<string, unknown>>(query: string, ...params: (string | number)[]): T[] => {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare(query).all(...params) as T[];
    } finally {
      db.close();
    }
  };
  const turnsOf = (id: number) =>
    sql<{ prompt: string; command: string }>(
      `SELECT prompt, command FROM sessions WHERE conversation_id = ? ORDER BY id`,
      id
    );
  const conversations = () =>
    sql<{ id: number; run_id: string | null; command: string }>(
      `SELECT id, run_id, command FROM conversations ORDER BY id`
    );

  /** Run `gth ask <prompt>` for real and return its conversation row. */
  const askFirst = async (prompt = 'first question') => {
    await gth('ask', prompt);
    const rows = conversations();
    return rows[rows.length - 1];
  };

  /** A refusal: said once, loudly, exit 1, and nothing ran — no model call, no turn recorded. */
  const expectRefused = (sessionsBefore: number) => {
    expect(systemMock.setExitCode).toHaveBeenCalledWith(1);
    expect(modelSaw).toEqual([]);
    expect(sql(`SELECT id FROM sessions`)).toHaveLength(sessionsBefore);
  };

  it('ACCEPTANCE: ask --resume <run id> continues the conversation from its checkpoint and records one row', async () => {
    const first = await askFirst();
    modelSaw.length = 0;

    await gth('ask', '--resume', first.run_id!, 'second question');

    // The model saw the first question on the thread, then the new one: the checkpoint was
    // re-entered, and the new input appended as a user message.
    expect(modelSaw).toHaveLength(1);
    expect(modelSaw[0][0]).toContain('first question');
    expect(modelSaw[0][modelSaw[0].length - 1]).toContain('second question');
    expect(conversations()).toEqual([first]);
    expect(turnsOf(first.id).map((t) => t.command)).toEqual(['ask', 'ask']);
    expect(systemMock.setExitCode).not.toHaveBeenCalled();
  });

  it('exec --resume <id> -m continues an ask conversation, and its command column stays ask', async () => {
    const first = await askFirst();
    modelSaw.length = 0;

    await gth('exec', '--resume', String(first.id), '-m', 'now as a script');

    expect(modelSaw).toHaveLength(1);
    expect(modelSaw[0][0]).toContain('first question');
    expect(modelSaw[0][modelSaw[0].length - 1]).toContain('now as a script');
    expect(conversations()).toEqual([first]);
    expect(turnsOf(first.id).map((t) => t.command)).toEqual(['ask', 'exec']);
    expect(systemMock.setExitCode).not.toHaveBeenCalled();
  });

  it('the root spelling, gth --resume <id> ask, resumes the same way', async () => {
    const first = await askFirst();
    modelSaw.length = 0;
    await gth('--resume', first.run_id!, 'ask', 'via the root flag');
    expect(modelSaw[0][0]).toContain('first question');
    expect(turnsOf(first.id)).toHaveLength(2);
  });

  describe('ACCEPTANCE (id resolution): a bad id fails loudly and never resumes the neighbour', () => {
    const noConversation = (token: string) => {
      expect(consoleMock.displayNotice).toHaveBeenCalledTimes(1);
      expect(consoleMock.displayNotice.mock.calls[0][0]).toBe(`No conversation ${token}`);
    };

    for (const verb of ['ask', 'exec'] as const) {
      const args = (id: string) =>
        verb === 'ask'
          ? ['ask', '--resume', id, 'must not run']
          : ['exec', '--resume', id, '-m', 'must not run'];

      it(`${verb}: an unknown integer`, async () => {
        const neighbour = await askFirst();
        vi.clearAllMocks();
        modelSaw.length = 0;
        await gth(...args(String(neighbour.id + 1)));
        noConversation(`#${neighbour.id + 1}`);
        expectRefused(1);
      });

      it(`${verb}: an unknown run id`, async () => {
        await askFirst();
        vi.clearAllMocks();
        modelSaw.length = 0;
        const unknown = '0f8fad5b-d9cb-469f-a165-70867728950e';
        await gth(...args(unknown));
        noConversation(unknown);
        expectRefused(1);
      });

      it(`${verb}: a run id minted by ANOTHER database, whose row sits at the same integer as one here`, async () => {
        const here = await askFirst();
        initConfigMock.mockImplementation(async () => configAt(resolve(dir, 'other.db')));
        await gth('ask', 'elsewhere');
        const other = new DatabaseSync(resolve(dir, 'other.db'));
        const elsewhere = other.prepare(`SELECT id, run_id FROM conversations`).get() as {
          id: number;
          run_id: string;
        };
        other.close();
        expect(elsewhere.id).toBe(here.id);
        initConfigMock.mockImplementation(async () => configAt(dbPath));
        vi.clearAllMocks();
        modelSaw.length = 0;

        await gth(...args(elsewhere.run_id));

        noConversation(elsewhere.run_id);
        expectRefused(1);
      });

      it(`${verb}: a stale run id, from a database since deleted and recreated`, async () => {
        const stale = await askFirst('before the database was recreated');
        rmSync(dbPath, { force: true });
        rmSync(`${dbPath}-wal`, { force: true });
        rmSync(`${dbPath}-shm`, { force: true });
        const fresh = await askFirst('after');
        // The recreated database hands out the same integer again.
        expect(fresh.id).toBe(stale.id);
        vi.clearAllMocks();
        modelSaw.length = 0;

        await gth(...args(stale.run_id!));

        noConversation(stale.run_id!);
        expectRefused(1);
        expect(turnsOf(fresh.id)).toHaveLength(1);
      });
    }
  });

  describe('ACCEPTANCE (matrix): each refused cell is loud, exits 1 and runs nothing', () => {
    const seedRow = async (over: { command: string; origin?: string }) => {
      const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
      const { openCheckpointSaver } = await import('@gaunt-sloth/core/history/checkpointSaver.js');
      const threadId = `thread-${over.command}-${over.origin ?? 'direct'}`;
      const recorded = recordSessionTurnSafe(
        { history: { dbPath } },
        { ...over, project: projectDir, threadId, prompt: 'p', response: 'r' }
      )!;
      const saver = openCheckpointSaver(dbPath)!;
      await saver.put(
        { configurable: { thread_id: threadId, checkpoint_ns: '' } },
        {
          v: 4,
          id: `cp-${threadId}`,
          ts: new Date().toISOString(),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );
      saver.close();
      return recorded.conversationId;
    };

    const cells: Array<{ row: { command: string; origin?: string }; named: string }> = [
      { row: { command: 'exec', origin: 'batch' }, named: '`gth batch`' },
      { row: { command: 'ask', origin: 'eval' }, named: '`gth eval`' },
      { row: { command: 'exec', origin: 'gth-batch' }, named: '`gth gth-batch`' },
      { row: { command: 'ask', origin: 'workflow' }, named: '`gth workflow`' },
      { row: { command: 'review' }, named: '`gth review`' },
      { row: { command: 'pr' }, named: '`gth pr`' },
    ];
    for (const { row, named } of cells) {
      for (const verb of ['ask', 'exec'] as const) {
        it(`${row.command}${row.origin ? ` (${row.origin} cell)` : ''} → ${verb} --resume`, async () => {
          const id = await seedRow(row);
          await gth(
            ...(verb === 'ask'
              ? ['ask', '--resume', String(id), 'm']
              : ['exec', '--resume', String(id), '-m', 'm'])
          );
          expect(consoleMock.displayNotice).toHaveBeenCalledTimes(1);
          const [title, lines] = consoleMock.displayNotice.mock.calls[0];
          expect(title).toBe(`Conversation #${id} cannot be resumed`);
          expect((lines as string[]).join(' ')).toContain(named);
          expect((lines as string[]).join(' ')).toContain('Nothing was run.');
          expectRefused(1);
        });
      }
    }
  });

  describe('exec --resume takes -m and nothing else', () => {
    const refusedBeforeConfig = (text: string) => {
      expect(consoleMock.displayError).toHaveBeenCalledWith(text);
      expect(systemMock.setExitCode).toHaveBeenCalledWith(1);
      expect(initConfigMock).not.toHaveBeenCalled();
      expect(modelSaw).toEqual([]);
    };

    it('refuses no -m, naming -m', async () => {
      await gth('exec', '--resume', '1');
      refusedBeforeConfig(
        '`gth exec --resume` needs the new message as -m, for example ' +
          '`gth exec --resume <id> -m "…"`. Nothing was run.'
      );
    });

    it('refuses a script path', async () => {
      await gth('exec', '--resume', '1', 'script.md');
      refusedBeforeConfig(
        '`gth exec --resume` takes its new input only from -m; a script path cannot be given ' +
          'with it. Nothing was run.'
      );
    });

    it('refuses -f files, even with -m', async () => {
      await gth('exec', '--resume', '1', '-m', 'hi', '-f', 'context.md');
      refusedBeforeConfig(
        '`gth exec --resume` takes its new input only from -m; -f files cannot be given with ' +
          'it. Nothing was run.'
      );
    });

    it('refuses a script piped on stdin', async () => {
      systemMock.getStringFromStdin.mockReturnValue('# a piped script');
      await gth('exec', '--resume', '1');
      refusedBeforeConfig(
        '`gth exec --resume` takes its new input only from -m; a script piped on stdin cannot ' +
          'be given with it. Nothing was run.'
      );
    });
  });

  it('REVISION 2: a stored grant is not in force on ask --write --resume, and the row’s grants are left as they were', async () => {
    const first = await askFirst();
    const { saveConversationGrantsSafe, loadConversationGrantsSafe } =
      await import('@gaunt-sloth/core/core/approvals/conversationGrants.js');
    saveConversationGrantsSafe({ history: { dbPath } }, first.id, {
      allow: [
        {
          entry: { type: 'shell', matcher: 'exact', pattern: 'git push' },
          grantedAt: '2026-09-01T10:00:00.000Z',
          scope: 'session',
        },
      ],
      deny: [],
    });
    const stored = loadConversationGrantsSafe({ history: { dbPath } }, first.id);
    expect(stored.allow).toHaveLength(1);

    // What the runner holds at the moment the resumed turn runs.
    const { GthAgentRunner } = await import('@gaunt-sloth/core/core/GthAgentRunner.js');
    const inForce: unknown[] = [];
    const processMessages = GthAgentRunner.prototype.processMessages;
    const spy = vi
      .spyOn(GthAgentRunner.prototype, 'processMessages')
      .mockImplementation(async function (this: InstanceType<typeof GthAgentRunner>, ...args) {
        inForce.push(this.getSessionScopedGrants());
        return processMessages.apply(this, args);
      });
    const restore = vi.spyOn(GthAgentRunner.prototype, 'resumeConversation');
    try {
      await gth('ask', '--write', '--resume', String(first.id), 'push it');
    } finally {
      spy.mockRestore();
      restore.mockRestore();
    }

    expect(systemMock.setExitCode).not.toHaveBeenCalled();
    expect(turnsOf(first.id)).toHaveLength(2);
    expect(inForce).toEqual([{ allow: [], deny: [] }]);
    expect(restore).not.toHaveBeenCalled();
    // Never written either: the row holds exactly what it held.
    expect(loadConversationGrantsSafe({ history: { dbPath } }, first.id)).toEqual(stored);
  });
});
