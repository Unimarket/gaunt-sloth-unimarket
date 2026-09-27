/**
 * GS2-107 — `gth history prune`, and the size readout on `gth history list`.
 *
 * A real store over a temp file; the command is driven through commander exactly as the CLI does.
 *
 * **Every invocation passes `--db <temp>`.** This command deletes rows and runs a VACUUM, so an
 * invocation without it would resolve to the developer's own `~/.gsloth/history.db` — the store the
 * root vitest global-setup guard fingerprints. The dry-run default is the second layer of that: a
 * prune removes nothing until `--yes`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  checkpointThreadIds,
  countRows,
  storeSizeOnDisk,
} from '../../core/spec/fixtures/historyStoreFiles.mjs';
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
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
}));
vi.mock('@gaunt-sloth/core/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gaunt-sloth/core/utils/consoleUtils.js')>()),
  ...consoleMock,
}));

const DAY = 24 * 60 * 60 * 1000;

describe('gth history prune (GS2-107)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-history-prune-'));
    dbPath = resolve(dir, 'history.db');
    initConfigMock.mockResolvedValue({ history: { dbPath } });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Everything the console was told, as one string, so a sentence can be asserted whole. */
  const output = (): string =>
    [
      ...consoleMock.display.mock.calls,
      ...consoleMock.displayInfo.mock.calls,
      ...consoleMock.displayWarning.mock.calls,
      ...consoleMock.displaySuccess.mock.calls,
    ]
      .map((c) => String(c[0]))
      .join('\n');

  const run = async (...args: string[]) => {
    const { historyCommand } = await import('#src/commands/historyCommand.js');
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    historyCommand(program, {});
    await program.parseAsync(['node', 'gth', 'history', ...args]);
  };

  /**
   * A conversation with `checkpoints` checkpoints under its thread, last active `ageDays` ago.
   * Built through the real store and the real saver, so the schema is the product's.
   */
  const seed = async (options: {
    threadId: string;
    ageDays: number;
    checkpoints?: number;
    payload?: number;
    named?: boolean;
  }): Promise<number | undefined> => {
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const { openCheckpointSaver } = await import('@gaunt-sloth/core/history/checkpointSaver.js');
    const ts = new Date(Date.now() - options.ageDays * DAY).toISOString();
    const store = openHistoryStore(dbPath, { create: true })!;
    let id: number | undefined;
    if (options.named !== false) {
      id = store.openConversation({ command: 'code', ts, threadId: options.threadId })!;
      store.record({ conversationId: id, command: 'code', ts, prompt: 'p', response: 'r' });
    }
    store.close();
    const saver = openCheckpointSaver(dbPath)!;
    const payload = 'x'.repeat(options.payload ?? 2000);
    for (let i = 0; i < (options.checkpoints ?? 3); i++) {
      await saver.put(
        {
          configurable: {
            thread_id: options.threadId,
            checkpoint_ns: '',
            ...(i > 0 ? { checkpoint_id: `cp-${options.threadId}-${i - 1}` } : {}),
          },
        },
        {
          v: 4,
          id: `cp-${options.threadId}-${i}`,
          ts,
          channel_values: { messages: payload },
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: i, parents: {} },
        {}
      );
    }
    saver.close();
    return id;
  };

  /** Every thread holding a checkpoint, read off the store's thread files (GS2-121). */
  const threadsInStore = (): string[] => checkpointThreadIds(dbPath) as string[];

  /**
   * GS2-108 — a thread holding pending writes with no checkpoint. `put` is fail-soft: a dropped
   * checkpoint write leaves the task's `putWrites` rows behind with nothing to attach them to, and
   * a torn delete did the same before the delete became atomic. Written straight through the
   * schema the store and the saver create, because no product path can be asked to fail on demand.
   */
  const addPendingWrite = async (
    threadId: string,
    checkpointId: string,
    bytes = 50_000
  ): Promise<void> => {
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const { openThreadDb } = await import('@gaunt-sloth/core/history/historyFiles.js');
    openHistoryStore(dbPath, { create: true })!.close();
    // GS2-121 — the thread's own file, created the way the saver creates it.
    const db = openThreadDb(dbPath, threadId, { create: true })!;
    db.prepare(
      `INSERT OR REPLACE INTO checkpoint_writes
       (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES (?, '', ?, 'task', 0, 'messages', 'json', ?)`
    ).run(threadId, checkpointId, new TextEncoder().encode('y'.repeat(bytes)));
    db.close();
  };

  /** The orphaned shape: the checkpoint the writes name is not in the store and never will be. */
  const seedWriteOnly = (threadId: string, bytes = 50_000): Promise<void> =>
    addPendingWrite(threadId, 'ckpt-gone', bytes);

  /** Pending-write rows a thread still holds, read off the store rather than off an output line. */
  const writeRowsFor = (threadId: string): number =>
    countRows(dbPath, 'checkpoint_writes', threadId) as number;

  it('refuses to guess a bound, and removes nothing', async () => {
    await seed({ threadId: 't-old', ageDays: 400 });
    await run('prune', '--db', dbPath);
    expect(output()).toContain('needs a bound');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  it('says what it will remove and removes nothing without --yes', async () => {
    const id = await seed({ threadId: 't-old', ageDays: 90 });
    await run('prune', '--older-than', '30', '--db', dbPath);
    const said = output();
    expect(said).toContain(`#${id}`);
    expect(said).toContain('Would remove the stored state of 1 conversation');
    expect(said).toContain('Their transcripts stay');
    expect(said).toContain('Re-run with `--yes`');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  it('removes what it names and nothing else, and the control conversation survives', async () => {
    const oldId = await seed({ threadId: 't-old', ageDays: 90 });
    const keptId = await seed({ threadId: 't-recent', ageDays: 2 });
    await run('prune', '--older-than', '30', '--yes', '--db', dbPath);

    expect(threadsInStore()).toEqual(['t-recent']);
    // The transcript is not what went: both conversations are still listable and readable.
    const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
    const store = openHistoryStore(dbPath)!;
    expect(
      store
        .listConversations(10)
        .map((c) => c.id)
        .sort()
    ).toEqual([oldId!, keptId!].sort());
    expect(store.getConversationThread(oldId!)).toHaveLength(1);
    store.close();
    expect(output()).toContain('Removed 3 checkpoints');
  });

  it('the file gets smaller — the VACUUM is what gives the space back', async () => {
    await seed({ threadId: 't-bulk', ageDays: 90, checkpoints: 40, payload: 20_000 });
    await seed({ threadId: 't-keep', ageDays: 1, checkpoints: 1, payload: 100 });
    // GS2-121 — the store is a directory, so its size is every file in it.
    const before = storeSizeOnDisk(dbPath);
    expect(before).toBeGreaterThan(500_000);

    await run('prune', '--older-than', '30', '--yes', '--db', dbPath);

    const after = storeSizeOnDisk(dbPath);
    expect(after).toBeLessThan(before / 2);
    expect(output()).toContain('Store on disk:');
    expect(threadsInStore()).toEqual(['t-keep']);
  });

  it('a count bound keeps the N most recent conversations WHOLE', async () => {
    await seed({ threadId: 't1', ageDays: 1 });
    await seed({ threadId: 't2', ageDays: 2 });
    await seed({ threadId: 't3', ageDays: 3 });
    await run('prune', '--keep-last', '2', '--yes', '--db', dbPath);
    expect(threadsInStore()).toEqual(['t1', 't2']);
    // Whole, not truncated: the kept conversations still hold every checkpoint they had.
    expect(countRows(dbPath, 'checkpoints', 't1')).toBe(3);
  });

  it('reclaims an unaddressable thread alongside, and says so', async () => {
    await seed({ threadId: 't-named', ageDays: 1 });
    await seed({ threadId: 't-orphan', ageDays: 90, named: false });
    await run('prune', '--keep-last', '5', '--yes', '--db', dbPath);
    expect(output()).toContain('no conversation names');
    expect(threadsInStore()).toEqual(['t-named']);
  });

  /**
   * GS2-108 — the whole point of the node, asserted on the rows rather than on a sentence. Before
   * this, `checkpoint_writes` rows whose `checkpoints` row was gone answered no candidate query in
   * the module, survived every pass including the widest bound this command accepts, and had their
   * bytes counted in the readout's live total.
   */
  it('reclaims a thread whose pending writes outlived its checkpoints, and leaves the rest alone', async () => {
    await seed({ threadId: 't-recent', ageDays: 1 });
    // The control, and the one that discriminates: a pending write of the SAME shape and size,
    // attached to a checkpoint that exists. A sweep keyed on anything coarser than "no checkpoint
    // row" — on the blob, on the table, on the absence of a conversation — takes this one too.
    await addPendingWrite('t-recent', 'cp-t-recent-0');
    await seedWriteOnly('t-writes-only');
    expect(writeRowsFor('t-writes-only')).toBe(1);

    await run('prune', '--older-than', '30', '--yes', '--db', dbPath);

    expect(writeRowsFor('t-writes-only')).toBe(0);
    expect(output()).toContain('pending writes with no checkpoint');
    // The bound selected no conversation, so the recent one is untouched — rows and writes alike.
    expect(threadsInStore()).toEqual(['t-recent']);
    expect(writeRowsFor('t-recent')).toBe(1);
  });

  it('removes them only after --yes, like everything else this command takes', async () => {
    await seed({ threadId: 't-recent', ageDays: 1 });
    await seedWriteOnly('t-writes-only');
    await run('prune', '--older-than', '30', '--db', dbPath);
    expect(output()).toContain('pending writes with no checkpoint');
    expect(output()).toContain('Re-run with `--yes`');
    expect(writeRowsFor('t-writes-only')).toBe(1);
  });

  /**
   * A store can hold nothing but write-only threads, and the plan's "is there anything to do"
   * guard runs before the confirmation does — so a set it does not count is a set that prints a
   * plan and then silently returns.
   */
  it('acts on a store that holds write-only threads and nothing else', async () => {
    await seedWriteOnly('t-writes-only');
    await run('prune', '--older-than', '30', '--yes', '--db', dbPath);
    expect(output()).not.toContain('Nothing to prune');
    expect(output()).toContain('History prune complete');
    expect(writeRowsFor('t-writes-only')).toBe(0);
  });

  it('refuses a bound that is not a whole number rather than reinterpreting it', async () => {
    await seed({ threadId: 't-old', ageDays: 400 });
    await run('prune', '--older-than', 'soon', '--yes', '--db', dbPath);
    expect(output()).toContain('is not a positive whole number');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  /**
   * GS2-107 fix round, finding E — the docstring said non-positive values were refused and the code
   * accepted `0`, which is the widest delete this command can make: `--older-than 0` means "older
   * than right now", so every conversation with stored state is selected, reached by typing the
   * smallest-looking bound there is. `--keep-last 0` is the same sentence from the other end.
   *
   * The empty forms are here because `Number('')` and `Number('  ')` are both `0` rather than
   * `NaN`, so they arrive at the numeric test already looking like a valid bound.
   */
  it.each([
    ['--older-than', '0'],
    ['--keep-last', '0'],
    ['--older-than', ''],
    ['--keep-last', '   '],
  ])('refuses %s %s and removes nothing', async (flag, value) => {
    await seed({ threadId: 't-old', ageDays: 400 });
    await run('prune', flag, value, '--yes', '--db', dbPath);
    expect(output()).toContain('is not a positive whole number');
    expect(output()).not.toContain('History prune complete');
    expect(threadsInStore()).toEqual(['t-old']);
  });

  /**
   * GS2-107 fix round, finding F — the command a person types has neither of the automatic pass's
   * guards, and the plan is where it says so. The marker rides on the row, the paragraph appears
   * once, and both are absent when nothing selected is recent — so a person reading a plan full of
   * year-old conversations is not told to worry about a window that is not open.
   */
  it('marks a recently active conversation in the plan and says prune does not skip an open one', async () => {
    await seed({ threadId: 't-newest', ageDays: 0 });
    await seed({ threadId: 't-hours-ago', ageDays: 0.2 });
    await seed({ threadId: 't-ancient', ageDays: 400 });
    await run('prune', '--keep-last', '1', '--db', dbPath);
    expect(output()).toContain('active today');
    expect(output()).toContain('may be open in another window right now');
    expect(output()).toContain('does not skip an open conversation');
    expect(threadsInStore()).toEqual(['t-ancient', 't-hours-ago', 't-newest']);
  });

  it('says none of that when everything selected is old', async () => {
    await seed({ threadId: 't-newest', ageDays: 0 });
    await seed({ threadId: 't-ancient', ageDays: 400 });
    await run('prune', '--keep-last', '1', '--db', dbPath);
    expect(output()).toContain('#');
    expect(output()).not.toContain('active today');
    expect(output()).not.toContain('may be open in another window right now');
  });

  it('says there is no history rather than creating a database', async () => {
    const absent = resolve(dir, 'nothing-here.db');
    await run('prune', '--older-than', '30', '--yes', '--db', absent);
    expect(output()).toContain('No session history found');
    expect(() => statSync(absent)).toThrow();
  });

  describe('the size readout on `gth history list`', () => {
    it('reports the shape the store was built to', async () => {
      await seed({ threadId: 't-a', ageDays: 1, checkpoints: 4, payload: 3000 });
      await seed({ threadId: 't-b', ageDays: 2, checkpoints: 2, payload: 3000 });
      await run('list', '--db', dbPath);
      const said = output();
      expect(said).toContain('Conversation store:');
      expect(said).toContain('6 checkpoints across 2 threads');
      expect(said).toContain('gth history prune');
    });

    it('MUTATION CONTROL: the numbers move with the store', async () => {
      await seed({ threadId: 't-a', ageDays: 1, checkpoints: 4, payload: 3000 });
      await run('list', '--db', dbPath);
      expect(output()).toContain('4 checkpoints across 1 thread');
      vi.resetAllMocks();
      initConfigMock.mockResolvedValue({ history: { dbPath } });
      await seed({ threadId: 't-b', ageDays: 1, checkpoints: 5, payload: 3000 });
      await run('list', '--db', dbPath);
      expect(output()).toContain('9 checkpoints across 2 threads');
    });

    it('stays quiet when there is nothing at all to report', async () => {
      const { openHistoryStore } = await import('@gaunt-sloth/core/history/historyStore.js');
      const store = openHistoryStore(dbPath, { create: true })!;
      store.record({ command: 'ask', prompt: 'p', response: 'r' });
      store.close();
      await run('list', '--db', dbPath);
      expect(output()).not.toContain('Conversation store:');
    });

    /**
     * GS2-111 — the primary witness, driven through the real command: a store holding both
     * checkpoints and orphaned pending writes. The orphan bytes are inside the headline figure, so
     * the sentence has to name them as their own share instead of charging them to the checkpoint
     * count.
     */
    it('does not charge the orphaned bytes to the checkpoint count', async () => {
      await seed({ threadId: 't-a', ageDays: 1, checkpoints: 4, payload: 3000 });
      await seedWriteOnly('t-orphan');
      await run('list', '--db', dbPath);
      const said = output();
      expect(said).toContain('4 checkpoints across 1 thread');
      expect(said).toContain('48.8 KB of that on 1 thread with no checkpoint');
      expect(said).not.toMatch(/of which [\d.]+ [KMG]?B is 4 checkpoints/);
    });

    /**
     * GS2-111 — a dropped first `put` can leave a store with pending writes and no checkpoint at
     * all: bytes on disk that only `gth history prune` takes back. The old guard read the
     * checkpoint count alone, so the one screen that reports the store's size said nothing about
     * such a store. This is the case that made the guard part of the node.
     */
    it('reports a store holding nothing but orphaned pending writes', async () => {
      await seedWriteOnly('t-orphan');
      await run('list', '--db', dbPath);
      const said = output();
      expect(said).toContain('Conversation store:');
      expect(said).toContain('1 thread with no checkpoint');
      expect(said).toContain('gth history prune');
      expect(said).not.toContain('0 checkpoints');
    });
  });
});
