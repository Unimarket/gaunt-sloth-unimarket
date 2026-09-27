/**
 * GS2-20 — `gth history resume <id> [message]`: starts the session in the mode the conversation was
 * recorded under, with the resume id, and (GS2-106) runs an ask or exec row as that command with the
 * new message. Every refusal — an unknown id, a bad id, history off, no store, a row the resume
 * matrix refuses, a single-shot row with no message — is a warning, nothing run, and exit status 1.
 * Takes no `--db`. Real store over a temp file; the session is mocked at `startSession` and the
 * single-shot commands at their bodies, which is where the seam takes over.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Command } from 'commander';

const startSessionMock = vi.hoisted(() => vi.fn());
vi.mock('#src/modules/startSession.js', () => ({ startSession: startSessionMock }));

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
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

// GS2-106 — the exit status and the piped message, read through the real module otherwise.
const systemMock = vi.hoisted(() => ({ setExitCode: vi.fn(), getStringFromStdin: vi.fn() }));
vi.mock('@gaunt-sloth/core/utils/systemUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/systemUtils.js')>()),
  ...systemMock,
}));

// GS2-106 — an ask or exec row runs through that command's own body; what this spec asserts is
// that `history resume` hands it the row, the message and the `history` surface. What the body
// then does with a resume is asserted in `singleShotResumeCommands.spec.ts`.
const runAskCommandMock = vi.hoisted(() => vi.fn());
vi.mock('#src/commands/askCommand.js', () => ({ runAskCommand: runAskCommandMock }));
const runExecCommandMock = vi.hoisted(() => vi.fn());
vi.mock('#src/commands/execCommand.js', () => ({ runExecCommand: runExecCommandMock }));

describe('gth history resume <id> (GS2-20)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-resume-'));
    dbPath = resolve(dir, 'history.db');
    initConfigMock.mockResolvedValue({ history: { dbPath } });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = async () => {
    const { openConversationSafe, recordSessionSafe } =
      await import('@gaunt-sloth/core/history/recordSession.js');
    const config = { history: { dbPath } };
    const codeId = openConversationSafe(config, { command: 'code', threadId: 'thread-code' })!;
    recordSessionSafe(config, {
      conversationId: codeId,
      command: 'code',
      prompt: 'p',
      response: 'r',
    });
    const chatId = openConversationSafe(config, { command: 'chat', threadId: 'thread-chat' })!;
    recordSessionSafe(config, {
      conversationId: chatId,
      command: 'chat',
      prompt: 'p',
      response: 'r',
    });
    const askId = recordSessionSafe(config, { command: 'ask', prompt: 'p', response: 'r' })!;
    return { codeId, chatId, askId };
  };

  /** A fresh program per invocation — commander refuses to register `history` twice. */
  const run = async (...args: string[]) => {
    const { historyCommand } = await import('#src/commands/historyCommand.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    historyCommand(program, { global: true });
    await program.parseAsync(['node', 'gth', 'history', 'resume', ...args]);
  };

  it('starts a code session inside a conversation recorded by gth code, passing the overrides through', async () => {
    const { codeId } = await seed();
    await run(String(codeId));
    expect(startSessionMock).toHaveBeenCalledTimes(1);
    const [sessionConfig, overrides, message, options] = startSessionMock.mock.calls[0];
    expect(sessionConfig).toEqual(expect.objectContaining({ mode: 'code' }));
    expect(overrides).toEqual({ global: true });
    expect(message).toBeUndefined();
    expect(options).toEqual({ resumeConversationId: codeId });
    // The config it looked the row up in is the one the session will run under.
    expect(initConfigMock).toHaveBeenCalledWith({ global: true });
    expect(consoleMock.displayWarning).not.toHaveBeenCalled();
  });

  it('starts a chat session inside a conversation recorded by gth chat', async () => {
    const { chatId } = await seed();
    await run(String(chatId));
    expect(startSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat' }),
      { global: true },
      undefined,
      { resumeConversationId: chatId }
    );
  });

  it('passes a message to a chat or code session as its first input', async () => {
    const { chatId } = await seed();
    await run(String(chatId), 'carry on from here');
    expect(startSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat' }),
      { global: true },
      'carry on from here',
      { resumeConversationId: chatId }
    );
  });

  // GS2-106 — a single-shot row runs as the command it was recorded under, with the message as
  // the new user input. This spelling never switches command.
  it('runs an ask row as ask, with the message, on the history surface — by integer and by run id', async () => {
    await seed();
    const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
    const ask = recordSessionTurnSafe(
      { history: { dbPath } },
      { command: 'ask', prompt: 'p', response: 'r', threadId: 'thread-ask' }
    )!;
    const id = ask.conversationId;
    await run(String(id), 'and then?');
    await run(ask.runId!, 'and then?');
    expect(runAskCommandMock.mock.calls).toEqual([
      ['and then?', {}, { global: true }, { ref: id, surface: 'history' }],
      ['and then?', {}, { global: true }, { ref: id, surface: 'history' }],
    ]);
    expect(runExecCommandMock).not.toHaveBeenCalled();
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(systemMock.setExitCode).not.toHaveBeenCalled();
  });

  it('runs an exec row as exec, with the message as -m', async () => {
    const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
    const exec = recordSessionTurnSafe(
      { history: { dbPath } },
      { command: 'exec', prompt: 'p', response: 'r', threadId: 'thread-exec' }
    )!;
    await run(String(exec.conversationId), 'now the tests');
    expect(runExecCommandMock).toHaveBeenCalledWith(
      undefined,
      { message: 'now the tests' },
      { global: true },
      { ref: exec.conversationId, surface: 'history' }
    );
    expect(runAskCommandMock).not.toHaveBeenCalled();
  });

  it('reads the message for a single-shot row from stdin when no positional is given', async () => {
    const { askId } = await seed();
    systemMock.getStringFromStdin.mockReturnValue('piped follow-up');
    await run(String(askId));
    expect(runAskCommandMock).toHaveBeenCalledWith(
      'piped follow-up',
      {},
      { global: true },
      { ref: askId, surface: 'history' }
    );
  });

  it('refuses a single-shot row with no message at all, naming how to give one, and exits 1', async () => {
    const { askId } = await seed();
    systemMock.getStringFromStdin.mockReturnValue('');
    await run(String(askId));
    expect(runAskCommandMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith(
      `Conversation #${askId} was recorded by \`gth ask\`, so resuming it needs a new message: ` +
        `\`gth history resume ${askId} "…"\`, or pipe one on stdin. Nothing was run.`
    );
    expect(systemMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('refuses a fan-out cell and a review row through the matrix, before asking for a message, and exits 1', async () => {
    const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
    const cell = recordSessionTurnSafe(
      { history: { dbPath } },
      { command: 'exec', origin: 'batch', prompt: 'p', response: 'r', threadId: 'thread-cell' }
    )!;
    const review = recordSessionTurnSafe(
      { history: { dbPath } },
      { command: 'review', prompt: 'p', response: 'r' }
    )!;
    for (const [id, named] of [
      [cell.conversationId, '`gth batch`'],
      [review.conversationId, '`gth review`'],
    ] as const) {
      vi.clearAllMocks();
      await run(String(id), 'a message that must not run');
      expect(runAskCommandMock).not.toHaveBeenCalled();
      expect(runExecCommandMock).not.toHaveBeenCalled();
      expect(startSessionMock).not.toHaveBeenCalled();
      expect(consoleMock.displayNotice).toHaveBeenCalledTimes(1);
      const [title, lines] = consoleMock.displayNotice.mock.calls[0];
      expect(title).toBe(`Conversation #${id} cannot be resumed`);
      expect((lines as string[]).join(' ')).toContain(named);
      expect((lines as string[]).join(' ')).toContain(`gth history show ${id}`);
      expect((lines as string[]).join(' ')).toContain('Nothing was run.');
      expect(systemMock.setExitCode).toHaveBeenCalledWith(1);
    }
  });

  // ACCEPTANCE (cross-command, one fixture, both rules) — the SAME ask row: `gth chat --resume`
  // takes it into an interactive session, and `gth history resume` runs it as `ask`.
  it('ACCEPTANCE: one ask row — chat --resume starts a chat session in it, history resume runs it as ask', async () => {
    const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
    const ask = recordSessionTurnSafe(
      { history: { dbPath } },
      { command: 'ask', prompt: 'p', response: 'r', threadId: 'thread-ask' }
    )!;
    const { chatCommand } = await import('#src/commands/chatCommand.js');
    const program = new Command();
    program.exitOverride();
    chatCommand(program, { global: true });
    await program.parseAsync(['node', 'gth', 'chat', '--resume', String(ask.conversationId)]);
    expect(startSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat' }),
      { global: true },
      undefined,
      { resumeConversationId: { kind: 'id', id: ask.conversationId } }
    );

    await run(String(ask.conversationId), 'follow-up');
    expect(runAskCommandMock).toHaveBeenCalledWith(
      'follow-up',
      {},
      { global: true },
      { ref: ask.conversationId, surface: 'history' }
    );
    // history resume never switched it into a session.
    expect(startSessionMock).toHaveBeenCalledTimes(1);
  });

  it('resolves a run id to its conversation and starts the session with that integer', async () => {
    const { chatId } = await seed();
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const store = openHistoryStore(dbPath, { create: false })!;
    const runId = store.listConversations(50).find((c) => c.id === chatId)!.runId!;
    store.close();
    await run(runId.toUpperCase());
    expect(startSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'chat' }),
      { global: true },
      undefined,
      { resumeConversationId: chatId }
    );
  });

  it('refuses, naming the token, an unknown run id, a run id from a different database, and 12abc', async () => {
    const { codeId } = await seed();
    const unknown = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await run(unknown);
    expect(consoleMock.displayWarning).toHaveBeenLastCalledWith(
      expect.stringContaining(`No conversation ${unknown}`)
    );

    // A run id minted by ANOTHER database, whose row sits at the same integer as one here.
    const { recordSessionTurnSafe } = await import('@gaunt-sloth/core/history/recordSession.js');
    const elsewhere = recordSessionTurnSafe(
      { history: { dbPath: resolve(dir, 'other.db') } },
      { command: 'code', prompt: 'p', response: 'r' }
    )!;
    expect(elsewhere.conversationId).toBe(codeId);
    await run(elsewhere.runId!);
    expect(consoleMock.displayWarning).toHaveBeenLastCalledWith(
      expect.stringContaining(`No conversation ${elsewhere.runId}`)
    );

    // Conversations 1..3 exist, so a parser that read `1abc` as 1 would start a session.
    expect(codeId).toBe(1);
    await run('1abc');
    expect(consoleMock.displayWarning).toHaveBeenLastCalledWith('Invalid conversation id "1abc".');
    expect(startSessionMock).not.toHaveBeenCalled();
    // GS2-106 — every one of the three refusals exits 1.
    expect(systemMock.setExitCode.mock.calls).toEqual([[1], [1], [1]]);
  });

  it('fails soft for an unknown id and for an id that is not one', async () => {
    await seed();
    await run('9999');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('No conversation #9999')
    );
    consoleMock.displayWarning.mockClear();
    await run('abc');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith('Invalid conversation id "abc".');
    // No config was loaded for a bad id — nothing to load it for.
    expect(initConfigMock).toHaveBeenCalledTimes(1);
    // GS2-106 — both exit 1: the person asked for something to run and it did not.
    expect(systemMock.setExitCode.mock.calls).toEqual([[1], [1]]);
  });

  it('fails soft when history is off, naming the switch', async () => {
    const { codeId } = await seed();
    initConfigMock.mockResolvedValue({ history: { dbPath, enabled: false } });
    await run(String(codeId));
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledWith(
      expect.stringContaining('`history.enabled: false`')
    );
    expect(systemMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('with no store at all says there is no history yet — the sentence history list uses — not that the id is unknown', async () => {
    // Nothing seeded: the database file does not exist.
    const { NO_HISTORY_MESSAGE } = await import('#src/commands/historyCommand.js');
    await run('1');
    expect(startSessionMock).not.toHaveBeenCalled();
    expect(consoleMock.displayWarning).toHaveBeenCalledTimes(1);
    const [warning] = consoleMock.displayWarning.mock.calls[0];
    expect(warning).toBe(NO_HISTORY_MESSAGE);
    expect(warning).toContain('No session history found');
    expect(warning).not.toContain('No conversation #1');
    expect(systemMock.setExitCode).toHaveBeenCalledWith(1);
  });

  it('takes no --db: the store is the one the session config names', async () => {
    const { codeId } = await seed();
    await expect(run(String(codeId), '--db', '/tmp/other.db')).rejects.toMatchObject({
      code: 'commander.unknownOption',
    });
    expect(startSessionMock).not.toHaveBeenCalled();
  });
});
