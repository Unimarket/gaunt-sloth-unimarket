/**
 * GS2-107 — the retention policy over a REAL store: the predicate that decides what automatic
 * reclamation may delete, the grace window that keeps it off a live session, the prune selection and
 * its bounds, the space a removal actually gives back, and the readout.
 *
 * GS2-121 — the store is a directory of one SQLite file per thread plus an index
 * (`historyLayout.ts`), so every fixture here writes a thread's rows into that thread's own file,
 * and every conversation is opened through the store itself so its record lands in its home file
 * exactly as the product writes it.
 *
 * Every test builds its own store under a temp dir; nothing here can reach `~/.gsloth/` — the paths
 * are constructed, never resolved from `HOME`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  collectCheckpointStoreStats,
  findUnaddressableThreads,
  findWriteOnlyThreads,
  openCheckpointMaintenance,
  reclaimUnresumableThreads,
  removeThreadState,
  selectPrunableConversations,
  NAMED_THREADS_SQL,
  RECLAIM_GRACE_MS,
} from '#src/history/checkpointRetention.js';
import { openHistoryStore } from '#src/history/historyStore.js';
import { historyStorePaths } from '#src/history/historyLayout.js';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';
import { openThreadDb } from '#src/history/historyFiles.js';
import { countRows, indexPath, threadFilePathOf } from './fixtures/historyStoreFiles.mjs';

const NOW = Date.parse('2026-09-04T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/**
 * An age measured from the REAL clock, for the cells that run the pass with no injected `now`. The
 * fixed `NOW` above cannot be used there: it is a written-down instant, so as real time moves past
 * it every fixture placed against it silently gets older, and a cell meant to sit just inside the
 * window would drift out of it.
 */
const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('GS2-107 checkpoint retention', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsloth-retention-'));
    dbPath = join(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Create the store the way the product does: the directory, `threads/` and the index. */
  const openStore = (path = dbPath): void => {
    openHistoryStore(path, { create: true })!.close();
  };

  /** Run `write` over one thread's own file, creating it the way the saver does. */
  const withThread = <T>(threadId: string, write: (db: DatabaseSync) => T, path = dbPath): T => {
    const db = openThreadDb(path, threadId, { create: true })!;
    try {
      return write(db);
    } finally {
      db.close();
    }
  };

  /**
   * Write `count` checkpoints for a thread, each carrying the serializer's real shape: plain JSON
   * with a top-level ISO `ts`, which is where the age gate reads a thread's age from. `payload` pads
   * the blob so byte accounting has something to count.
   */
  const seedThread = (
    threadId: string,
    options: { count?: number; ts?: string; payload?: number; path?: string } = {}
  ): void => {
    const count = options.count ?? 3;
    const ts = options.ts ?? ago(10 * DAY);
    const payload = 'x'.repeat(options.payload ?? 64);
    withThread(
      threadId,
      (db) => {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
           VALUES (?, '', ?, ?, 'json', ?, ?)`
        );
        const insertWrite = db.prepare(
          `INSERT OR REPLACE INTO checkpoint_writes
           (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
           VALUES (?, '', ?, 'task', ?, 'messages', 'json', ?)`
        );
        // GS2-109: one transaction for the whole seed. Every autocommit statement in rollback-journal
        // mode is its own journal create/fsync/delete, the cycle that made this file cost 26 s on the
        // Windows cell.
        db.exec('BEGIN');
        try {
          for (let i = 0; i < count; i++) {
            const id = `ckpt-${String(i).padStart(4, '0')}`;
            const body = new TextEncoder().encode(
              JSON.stringify({ v: 4, id, ts, channel_values: { messages: payload } })
            );
            insert.run(
              threadId,
              id,
              i === 0 ? null : `ckpt-${String(i - 1).padStart(4, '0')}`,
              body,
              new TextEncoder().encode(JSON.stringify({ step: i }))
            );
            insertWrite.run(threadId, id, i, new TextEncoder().encode(JSON.stringify(payload)));
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
      options.path ?? dbPath
    );
  };

  /**
   * A conversation naming `threadId`, with `turns` recorded turns at `lastTs`, opened through the
   * store so its record lands in its home file — the thread file it names — exactly as the product
   * writes it.
   */
  const seedConversation = (options: {
    threadId: string | null;
    command?: string;
    lastTs?: string;
    turns?: number;
    path?: string;
  }): number => {
    const lastTs = options.lastTs ?? ago(10 * DAY);
    const command = options.command ?? 'chat';
    const store = openHistoryStore(options.path ?? dbPath, { create: true })!;
    try {
      const id = store.openConversation({
        ts: lastTs,
        project: '/work',
        command,
        model: 'm',
        threadId: options.threadId ?? undefined,
      })!;
      expect(id).not.toBeNull();
      for (let i = 0; i < (options.turns ?? 1); i++) {
        store.record({
          conversationId: id,
          ts: lastTs,
          project: '/work',
          command,
          model: 'm',
          prompt: 'p',
          response: 'r',
        });
      }
      return id;
    } finally {
      store.close();
    }
  };

  /**
   * GS2-108 — the write-only shape: pending writes with no checkpoint to attach them to. What a
   * dropped `put` leaves behind when the task's `putWrites` still lands.
   */
  const seedWriteOnly = (threadId: string, bytes = 50_000): void =>
    withThread(threadId, (db) => {
      db.prepare(
        `INSERT OR REPLACE INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
         VALUES (?, '', 'ckpt-gone', 'task', 0, 'messages', 'json', ?)`
      ).run(threadId, new TextEncoder().encode('y'.repeat(bytes)));
    });

  /**
   * Put a conversation record into a THREAD's file: the mixed shape this release never writes (a
   * conversation's record has a file of its own) but a hand-built or damaged store could hold.
   */
  const seedRecordInto = (threadId: string): void =>
    withThread(threadId, (db) => {
      db.prepare(
        `INSERT INTO conversation_records (id, started_ts, command, thread_id)
         VALUES (900, ?, 'chat', ?)`
      ).run(ago(10 * DAY), threadId);
    });

  /** How many rows one table holds for a thread — read off that thread's own file. */
  const rowsFor = (table: string, threadId: string): number =>
    countRows(dbPath, table, threadId) as number;

  /** Rows of a table inside one thread's file, for the tables `countRows` does not cover. */
  const fileRows = (threadId: string, table: string): number =>
    withThread(threadId, (db) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)
    );

  describe('the predicate — a thread no conversation row names', () => {
    it('finds an orphan thread and leaves a named one alone', () => {
      openStore();
      seedThread('named');
      seedThread('orphan');
      seedConversation({ threadId: 'named' });

      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual(['orphan']);
    });

    it('a conversation whose thread link was CUT leaves its thread unaddressable — the two classes are one', () => {
      openStore();
      seedThread('was-linked');
      const id = seedConversation({ threadId: 'was-linked' });
      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual([]);

      // What a failed checkpoint write does. The link is destroyed, so the thread it named becomes
      // an orphan by the same predicate — there is no second query.
      const store = openHistoryStore(dbPath)!;
      store.clearConversationThread(id);
      store.close();
      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual(['was-linked']);
    });

    it('holds a thread inside the grace window, and releases it once past — the /clear case', () => {
      openStore();
      seedThread('live-after-clear', { ts: ago(RECLAIM_GRACE_MS - 60_000) });
      seedThread('finished', { ts: ago(RECLAIM_GRACE_MS + 60_000) });

      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual(['finished']);
      // The readout asks a different question — what is unaddressable at all — and sees both.
      expect(
        findUnaddressableThreads(dbPath, { now: NOW, includeWithinGrace: true }).sort()
      ).toEqual(['finished', 'live-after-clear']);
    });

    it('never offers the caller its own thread', () => {
      openStore();
      seedThread('mine', { ts: ago(30 * DAY) });
      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual(['mine']);
      expect(findUnaddressableThreads(dbPath, { now: NOW, excludeThreadIds: ['mine'] })).toEqual(
        []
      );
    });

    it('leaves a thread whose age cannot be read alone — an unknown age is never old enough', () => {
      openStore();
      seedThread('unreadable', { ts: ago(30 * DAY) });
      withThread('unreadable', (db) =>
        db
          .prepare(`UPDATE checkpoints SET checkpoint = ?`)
          .run(new TextEncoder().encode('not json at all'))
      );
      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual([]);
    });

    it('does nothing at all when the index cannot be read, rather than calling everything an orphan', () => {
      // Without the conversation rows every thread would satisfy "no conversation row names it",
      // and a sweep would delete the whole store.
      openStore();
      seedThread('named', { ts: ago(30 * DAY) });
      seedConversation({ threadId: 'named' });
      seedThread('orphan', { ts: ago(30 * DAY) });
      writeFileSync(indexPath(dbPath), 'this is not a database');

      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual([]);
      expect(reclaimUnresumableThreads(dbPath, { now: NOW })).toMatchObject({ threadCount: 0 });
      expect(rowsFor('checkpoints', 'named')).toBe(3);
      expect(rowsFor('checkpoints', 'orphan')).toBe(3);
    });

    it('a MISSING index is rebuilt from the thread files before the predicate reads it — a named thread stays named', () => {
      openStore();
      seedThread('named', { ts: ago(30 * DAY) });
      seedConversation({ threadId: 'named' });
      seedThread('orphan', { ts: ago(30 * DAY) });
      rmSync(indexPath(dbPath));

      // The conversation's record lives in its home file, so the rebuilt index names the thread
      // again and only the true orphan is offered.
      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual(['orphan']);
      expect(existsSync(indexPath(dbPath))).toBe(true);
    });
  });

  describe('removal', () => {
    it('deletes the file of a thread no conversation lives in, and reports what it held', () => {
      openStore();
      seedThread('gone', { count: 4, payload: 500 });
      seedThread('kept', { count: 2, payload: 500 });
      const gonePath = threadFilePathOf(dbPath, 'gone')!;

      const summary = removeThreadState(dbPath, ['gone']);
      expect(summary.threadCount).toBe(1);
      expect(summary.checkpointCount).toBe(4);
      expect(summary.writeCount).toBe(4);
      expect(summary.bytes).toBeGreaterThan(4 * 500);

      expect(existsSync(gonePath)).toBe(false);
      expect(rowsFor('checkpoints', 'kept')).toBe(2);
      expect(rowsFor('checkpoint_writes', 'kept')).toBe(2);
    });

    it("deletes a NAMED conversation's thread file whole, and its transcript survives in its own record file", () => {
      // Rule 6: prune deletes whole thread files. The transcript promise holds anyway, because the
      // conversation's record and turns were never in the thread's file.
      openStore();
      seedThread('named', { count: 3 });
      const id = seedConversation({ threadId: 'named', turns: 2 });
      const threadPath = threadFilePathOf(dbPath, 'named')!;

      expect(removeThreadState(dbPath, ['named'])).toMatchObject({
        threadCount: 1,
        checkpointCount: 3,
      });
      expect(existsSync(threadPath)).toBe(false);

      // Listed and readable now, and still there after the index is rebuilt from the files alone.
      rmSync(indexPath(dbPath));
      const store = openHistoryStore(dbPath)!;
      expect(store.getConversation(id)).not.toBeNull();
      expect(store.getConversationThread(id)).toHaveLength(2);
      // …and no longer resumable: the file its link names is gone.
      expect(store.getConversationThreadId(id)).toBeNull();
      store.close();
    });

    /**
     * The fallback path: a file that holds a conversation record as well as checkpoints. This
     * release never writes one (a conversation's record has its own file), but a hand-built or
     * damaged store can hold one, and deleting it would lose the record. It is stripped instead.
     */
    it('strips a file that also holds a conversation record, and keeps the record', () => {
      openStore();
      seedThread('mixed', { count: 3 });
      seedRecordInto('mixed');

      expect(removeThreadState(dbPath, ['mixed'])).toMatchObject({ threadCount: 1 });
      expect(rowsFor('checkpoints', 'mixed')).toBe(0);
      expect(rowsFor('checkpoint_writes', 'mixed')).toBe(0);
      expect(fileRows('mixed', 'conversation_records')).toBe(1);
    });

    /**
     * GS2-107 fix round, finding D — the two deletes of a strip are one transaction, pinned by
     * making the SECOND one fail. A `BEFORE DELETE` trigger that raises makes the delete of
     * `checkpoint_writes` abort exactly where a disk error or a lock would, with the first delete
     * already issued. Without the transaction the checkpoints are gone and the pending writes remain.
     * Only the strip path has two deletes; a whole-file delete has none to tear.
     */
    it('rolls the whole strip back when the second table refuses — no orphaned pending writes', () => {
      openStore();
      seedThread('both-tables', { count: 3 });
      seedRecordInto('both-tables');
      withThread('both-tables', (db) =>
        db.exec(
          `CREATE TRIGGER refuse_write_deletes BEFORE DELETE ON checkpoint_writes
           BEGIN SELECT RAISE(ABORT, 'blocked'); END`
        )
      );

      expect(removeThreadState(dbPath, ['both-tables'])).toMatchObject({
        threadCount: 0,
        checkpointCount: 0,
        writeCount: 0,
      });
      expect(rowsFor('checkpoints', 'both-tables')).toBe(3);
      expect(rowsFor('checkpoint_writes', 'both-tables')).toBe(3);

      // CONTROL: with the refusal lifted the same call removes both halves, so the assertion above
      // is about the rollback and not about a strip that never worked.
      withThread('both-tables', (db) => db.exec(`DROP TRIGGER refuse_write_deletes`));
      expect(removeThreadState(dbPath, ['both-tables'])).toMatchObject({
        threadCount: 1,
        checkpointCount: 3,
        writeCount: 3,
      });
      expect(rowsFor('checkpoints', 'both-tables')).toBe(0);
      expect(rowsFor('checkpoint_writes', 'both-tables')).toBe(0);
    });

    it('a refusal on one thread costs only that thread — the others go, and the summary counts only what went', () => {
      // GS2-121 — one file per thread makes each removal its own file operation, so a batch is no
      // longer one transaction. What must hold instead is that the summary is true: a thread it
      // counts is gone, and a thread it does not count is intact.
      openStore();
      seedThread('first', { count: 2 });
      seedConversation({ threadId: 'first' });
      // The one that refuses: a file on the strip path, whose strip is made to fail.
      seedThread('second', { count: 2 });
      seedRecordInto('second');
      withThread('second', (db) =>
        db.exec(
          `CREATE TRIGGER refuse_second BEFORE DELETE ON checkpoint_writes
           BEGIN SELECT RAISE(ABORT, 'blocked'); END`
        )
      );
      expect(removeThreadState(dbPath, ['first', 'second'])).toMatchObject({
        threadCount: 1,
        checkpointCount: 2,
      });
      expect(rowsFor('checkpoints', 'first')).toBe(0);
      expect(rowsFor('checkpoints', 'second')).toBe(2);
      expect(rowsFor('checkpoint_writes', 'second')).toBe(2);
    });

    it('the saver-level single-thread spelling and the batch are the same removal', async () => {
      const saverPath = join(dir, 'saver.db');
      openStore(saverPath);
      const saver = openCheckpointSaver(saverPath)!;
      seedThread('one', { path: saverPath });
      await saver.deleteThread('one');
      saver.close();
      expect(countRows(saverPath, 'checkpoints')).toBe(0);
      expect(countRows(saverPath, 'checkpoint_writes')).toBe(0);
    });
  });

  describe('prune selection', () => {
    it('selects nothing at all when neither bound is given — there is no silent default', () => {
      openStore();
      seedThread('t-old');
      seedConversation({ threadId: 't-old', lastTs: ago(400 * DAY) });
      expect(selectPrunableConversations(dbPath, { now: NOW })).toEqual([]);
    });

    it('an age bound selects the conversations past it and no others', () => {
      openStore();
      seedThread('t-old');
      seedThread('t-recent');
      const oldId = seedConversation({ threadId: 't-old', lastTs: ago(40 * DAY) });
      seedConversation({ threadId: 't-recent', lastTs: ago(2 * DAY) });

      const picked = selectPrunableConversations(dbPath, { olderThanDays: 30, now: NOW });
      expect(picked.map((c) => c.conversationId)).toEqual([oldId]);
      expect(picked[0].checkpointCount).toBe(3);
      expect(picked[0].bytes).toBeGreaterThan(0);
    });

    it('a count bound keeps the N most recently active conversations WHOLE and prunes the rest', () => {
      openStore();
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) {
        seedThread(`t${i}`);
        ids.push(seedConversation({ threadId: `t${i}`, lastTs: ago((i + 1) * DAY) }));
      }
      // ids[0] is the most recent. Keeping 2 prunes the two oldest, entire.
      const picked = selectPrunableConversations(dbPath, { keepLast: 2, now: NOW });
      expect(picked.map((c) => c.conversationId).sort()).toEqual([ids[2], ids[3]].sort());
      // Whole threads: every checkpoint of a selected conversation goes, none of a kept one.
      expect(picked.every((c) => c.checkpointCount === 3)).toBe(true);
    });

    it('both bounds compose as a conjunction', () => {
      openStore();
      seedThread('t-old');
      seedThread('t-older');
      const older = seedConversation({ threadId: 't-older', lastTs: ago(90 * DAY) });
      seedConversation({ threadId: 't-old', lastTs: ago(40 * DAY) });
      // Old enough for the age bound, but `keepLast: 1` protects the newest of the two.
      const picked = selectPrunableConversations(dbPath, {
        olderThanDays: 30,
        keepLast: 1,
        now: NOW,
      });
      expect(picked.map((c) => c.conversationId)).toEqual([older]);
    });

    it('never offers a conversation whose thread holds nothing to remove', () => {
      openStore();
      // The home file exists (it holds the record) but carries no checkpoint.
      seedConversation({ threadId: 'empty-thread', lastTs: ago(400 * DAY) });
      expect(threadFilePathOf(dbPath, 'empty-thread')).toBeDefined();
      expect(selectPrunableConversations(dbPath, { olderThanDays: 1, now: NOW })).toEqual([]);
    });

    /**
     * GS2-107 fix round, finding F — the typed command has neither of the automatic pass's guards,
     * and the shape that exposes it is `--keep-last`. The choice made here is to SAY so rather than
     * to hold the rows back.
     */
    it('marks a candidate whose last turn is inside the grace window as recently active', () => {
      openStore();
      for (const t of ['t-newest', 't-minutes-ago', 't-ancient']) seedThread(t);
      seedConversation({ threadId: 't-newest', lastTs: ago(5 * 60_000) });
      const recent = seedConversation({ threadId: 't-minutes-ago', lastTs: ago(20 * 60_000) });
      const ancient = seedConversation({ threadId: 't-ancient', lastTs: ago(40 * DAY) });

      const picked = selectPrunableConversations(dbPath, { keepLast: 1, now: NOW });
      const byId = new Map(picked.map((c) => [c.conversationId, c]));
      expect([...byId.keys()].sort()).toEqual([recent, ancient].sort());
      expect(byId.get(recent)?.recentlyActive).toBe(true);
      expect(byId.get(ancient)?.recentlyActive).toBe(false);
    });

    it('reads the flag off the same window the automatic pass uses, on both sides of it', () => {
      openStore();
      for (const t of ['t-kept', 't-inside', 't-outside']) seedThread(t);
      seedConversation({ threadId: 't-kept', lastTs: ago(60_000) });
      const inside = seedConversation({
        threadId: 't-inside',
        lastTs: ago(RECLAIM_GRACE_MS - 60_000),
      });
      const outside = seedConversation({
        threadId: 't-outside',
        lastTs: ago(RECLAIM_GRACE_MS + 60_000),
      });
      const picked = selectPrunableConversations(dbPath, { keepLast: 1, now: NOW });
      const byId = new Map(picked.map((c) => [c.conversationId, c]));
      expect(byId.get(inside)?.recentlyActive).toBe(true);
      expect(byId.get(outside)?.recentlyActive).toBe(false);
    });
  });

  /**
   * GS2-107 fix round, finding B — **the values that actually ship, exercised with nothing
   * injected.** These run the pass the way the close hook runs it, so the shipped number is the
   * only thing deciding, and a change to it in either direction reds one of them.
   */
  describe('the constants that ship', () => {
    it('a bare pass keeps a thread written 23 hours ago and reclaims one written 25 hours ago', () => {
      openStore();
      seedThread('inside-the-window', { ts: realAgo(23 * HOUR) });
      seedThread('past-the-window', { ts: realAgo(25 * HOUR) });

      expect(reclaimUnresumableThreads(dbPath)).toMatchObject({ threadCount: 1 });

      expect(rowsFor('checkpoints', 'inside-the-window')).toBe(3);
      expect(rowsFor('checkpoints', 'past-the-window')).toBe(0);
    });

    it('a saver never reclaims a thread it has written, however old that thread is', async () => {
      const path = join(dir, 'writeset.db');
      openStore(path);
      const saver = openCheckpointSaver(path)!;

      // A thread left by a session that is gone, and one this saver writes itself. Both are
      // unaddressable and both are far past the window, so the exclusion is the only difference.
      seedThread('left-by-someone-else', { ts: realAgo(30 * DAY), path });
      await saver.put(
        { configurable: { thread_id: 'written-by-this-saver', checkpoint_ns: '' } },
        {
          v: 4,
          id: 'cp-1',
          ts: realAgo(30 * DAY),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );

      // No arguments: the shipped grace window and the saver's own write set, exactly as the close
      // hook calls it.
      expect(saver.reclaimUnresumableThreads()).toMatchObject({ threadCount: 1 });
      saver.close();

      expect(countRows(path, 'checkpoints', 'written-by-this-saver')).toBe(1);
      expect(countRows(path, 'checkpoints', 'left-by-someone-else')).toBe(0);
    });

    it("a caller's exclusion adds to the saver's own and can never subtract from it", async () => {
      const path = join(dir, 'writeset-union.db');
      openStore(path);
      const saver = openCheckpointSaver(path)!;
      seedThread('named-by-the-caller', { ts: realAgo(30 * DAY), path });
      seedThread('nobody-protects-this', { ts: realAgo(30 * DAY), path });
      await saver.put(
        { configurable: { thread_id: 'written-by-this-saver', checkpoint_ns: '' } },
        {
          v: 4,
          id: 'cp-1',
          ts: realAgo(30 * DAY),
          channel_values: {},
          channel_versions: {},
          versions_seen: {},
        },
        { source: 'loop', step: 0, parents: {} },
        {}
      );

      expect(
        saver.reclaimUnresumableThreads({ excludeThreadIds: ['named-by-the-caller'] })
      ).toMatchObject({ threadCount: 1 });
      saver.close();

      expect(countRows(path, 'checkpoints', 'written-by-this-saver')).toBe(1);
      expect(countRows(path, 'checkpoints', 'named-by-the-caller')).toBe(3);
      expect(countRows(path, 'checkpoints', 'nobody-protects-this')).toBe(0);
    });
  });

  /**
   * GS2-107 fix round, finding C — the predicate reads the named threads out of `conversations`
   * once per pass, and it runs at every session exit, so that read must ride on the index rather
   * than scan the table. Pinned by the query plan, matched on the index NAME, because timing
   * assertions on shared runners flake and plan wording varies between SQLite builds.
   */
  describe('the index the predicate rides on', () => {
    it('the store creates it, and the named-thread read plans through it rather than a table scan', () => {
      openStore();
      seedThread('a');
      seedConversation({ threadId: 'a' });
      const db = new DatabaseSync(indexPath(dbPath), { readOnly: true });
      try {
        expect(
          db
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
            .get('idx_conversations_thread_id')
        ).toBeDefined();
        const plan = (
          db.prepare(`EXPLAIN QUERY PLAN ${NAMED_THREADS_SQL}`).all() as Record<string, unknown>[]
        )
          .map((r) => String(r.detail))
          .join('\n');
        expect(plan).toContain('idx_conversations_thread_id');
      } finally {
        db.close();
      }
    });

    it('a single-file store written before the thread column existed is split, and its index gets the column, the grants column AND the index', () => {
      // The ordering constraint, pinned: the index covers a column a migration adds, so creating it
      // first would throw. Only the ALTERs landing alongside the index proves the order is right.
      const legacyPath = join(dir, 'legacy.db');
      const legacy = new DatabaseSync(legacyPath);
      legacy.exec(`
        CREATE TABLE conversations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_ts TEXT NOT NULL, project TEXT, command TEXT, model TEXT
        );
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL, project TEXT, command TEXT, model TEXT,
          prompt TEXT, response TEXT
        );
      `);
      legacy.close();

      openHistoryStore(legacyPath, { create: true })!.close();

      expect(statSync(legacyPath).isDirectory()).toBe(true);
      const check = new DatabaseSync(historyStorePaths(legacyPath).index, { readOnly: true });
      try {
        const columns = (
          check.prepare(`PRAGMA table_info(conversations)`).all() as Record<string, unknown>[]
        ).map((c) => String(c.name));
        expect(columns).toContain('thread_id');
        expect(columns).toContain('grants');
        expect(
          check
            .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
            .get('idx_conversations_thread_id')
        ).toBeDefined();
      } finally {
        check.close();
      }
    });
  });

  /**
   * The disk space a removal gives back. A thread's file is deleted, so its bytes come back
   * outright. A file on the strip path must be VACUUMed, because a delete alone only moves pages
   * onto the freelist: `page_size` is 4096 and `auto_vacuum` is 0. The fixture is sized a step above
   * the floor where a delete starts to free whole pages (measured: 4 x 4,000 bytes frees 9 pages),
   * because SQLite's packing is lumpy and a fixture hugging the floor would prove nothing on a
   * matrix cell with a different SQLite build.
   */
  describe('the part that gives the disk space back', () => {
    const BULK_CHECKPOINTS = 4;
    const BULK_PAYLOAD = 4_000;
    const BULK_BYTES = BULK_CHECKPOINTS * BULK_PAYLOAD;

    it('a removed thread gives back its whole file, named or not', () => {
      openStore();
      seedThread('orphan-bulk', { count: BULK_CHECKPOINTS, payload: BULK_PAYLOAD });
      seedThread('named-bulk', { count: BULK_CHECKPOINTS, payload: BULK_PAYLOAD });
      seedConversation({ threadId: 'named-bulk' });
      const paths = ['orphan-bulk', 'named-bulk'].map((t) => threadFilePathOf(dbPath, t)!);
      for (const path of paths) expect(statSync(path).size).toBeGreaterThanOrEqual(BULK_BYTES);
      removeThreadState(dbPath, ['orphan-bulk', 'named-bulk']);
      for (const path of paths) expect(existsSync(path)).toBe(false);
    });

    it('a stripped file shrinks, and the CONTROL shows a delete alone does not', () => {
      openStore();
      // Two identical files on the strip path: one stripped by hand without a VACUUM (the
      // control), one through the product's removal.
      for (const thread of ['control', 'pruned']) {
        seedThread(thread, { count: BULK_CHECKPOINTS, payload: BULK_PAYLOAD });
        seedRecordInto(thread);
      }
      const controlPath = threadFilePathOf(dbPath, 'control')!;
      const prunedPath = threadFilePathOf(dbPath, 'pruned')!;
      const grown = statSync(prunedPath).size;
      expect(statSync(controlPath).size).toBe(grown);

      // CONTROL — the rows are gone and the file has not moved, DESPITE whole pages being free.
      const reclaimable = withThread('control', (db) => {
        db.exec('DELETE FROM checkpoints; DELETE FROM checkpoint_writes;');
        const pages = Number(
          (db.prepare(`PRAGMA freelist_count`).get() as Record<string, unknown>).freelist_count
        );
        const pageSize = Number(
          (db.prepare(`PRAGMA page_size`).get() as Record<string, unknown>).page_size
        );
        return pages * pageSize;
      });
      expect(statSync(controlPath).size).toBe(grown);
      expect(reclaimable).toBeGreaterThanOrEqual(BULK_BYTES);

      expect(removeThreadState(dbPath, ['pruned'])).toMatchObject({ threadCount: 1 });
      expect(grown - statSync(prunedPath).size).toBeGreaterThanOrEqual(BULK_BYTES);
      // …and the conversation record survived the compaction.
      expect(fileRows('pruned', 'conversation_records')).toBe(1);
    });
  });

  /**
   * GS2-108 — the class the conversation predicate cannot see: a thread whose rows are only in
   * `checkpoint_writes`.
   */
  describe('the second predicate — pending writes with no checkpoint', () => {
    it('finds a write-only thread and leaves every thread that HAS a checkpoint alone', () => {
      openStore();
      seedThread('named', { ts: ago(30 * DAY) });
      seedConversation({ threadId: 'named' });
      seedThread('unaddressable', { ts: ago(30 * DAY) });
      seedWriteOnly('writes-only');

      expect(findWriteOnlyThreads(dbPath)).toEqual(['writes-only']);
      // A thread with checkpoints has pending writes too — they are exactly what must NOT answer
      // this predicate, or a live conversation's rows would.
      expect(rowsFor('checkpoint_writes', 'named')).toBeGreaterThan(0);
    });

    it('never offers the caller its own thread', () => {
      openStore();
      seedWriteOnly('mine');
      expect(findWriteOnlyThreads(dbPath, { excludeThreadIds: ['mine'] })).toEqual([]);
    });

    /**
     * Deliberate, and the reason the sweep rides on `gth history prune` alone: the automatic pass
     * reclaims only what it can date, and a thread with no checkpoint carries no `ts` to read.
     */
    it('is NOT taken by the automatic pass, at any age', () => {
      openStore();
      seedWriteOnly('writes-only');
      expect(findUnaddressableThreads(dbPath, { now: NOW })).toEqual([]);
      expect(reclaimUnresumableThreads(dbPath, { now: NOW + 365 * DAY })).toMatchObject({
        threadCount: 0,
      });
      expect(rowsFor('checkpoint_writes', 'writes-only')).toBe(1);
    });

    it('does nothing with a thread file that has no checkpoints table, rather than calling its writes orphans', () => {
      // A file this release did not build: without `checkpoints` the predicate has nothing to test
      // against and would answer "all of them".
      openStore();
      const threads = historyStorePaths(dbPath).threads;
      mkdirSync(threads, { recursive: true });
      const db = new DatabaseSync(join(threads, 'lonely.db'));
      db.exec(
        `CREATE TABLE thread_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO thread_meta VALUES ('thread_id', 'lonely');
         CREATE TABLE checkpoint_writes (
           thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
           task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL,
           type TEXT, value BLOB,
           PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
         INSERT INTO checkpoint_writes VALUES ('lonely', '', 'c', 't', 0, 'messages', 'json', x'00');`
      );
      db.close();
      expect(findWriteOnlyThreads(dbPath)).toEqual([]);
    });

    it('the readout counts those bytes as write-only, inside the total it was already reporting', () => {
      openStore();
      seedThread('named', { count: 2, payload: 100, ts: ago(2 * DAY) });
      seedConversation({ threadId: 'named' });
      seedWriteOnly('writes-only', 50_000);
      const stats = collectCheckpointStoreStats(dbPath);

      expect(stats.writeOnlyThreadCount).toBe(1);
      expect(stats.writeOnlyBytes).toBe(50_000);
      expect(stats.checkpointBytes).toBeGreaterThan(50_000);
    });

    it('is a set disjoint from the unaddressable one — a thread cannot be in both', () => {
      openStore();
      seedThread('no-conversation', { ts: ago(30 * DAY) });
      seedWriteOnly('writes-only');

      const unaddressable = findUnaddressableThreads(dbPath, {
        now: NOW,
        includeWithinGrace: true,
      });
      expect(unaddressable).toContain('no-conversation');
      expect(unaddressable).not.toContain('writes-only');
      expect(findWriteOnlyThreads(dbPath)).not.toContain('no-conversation');
    });
  });

  describe('the readout', () => {
    it('reports the shape the store was built to', () => {
      openStore();
      seedThread('big', { count: 5, payload: 4000 });
      seedThread('small', { count: 2, payload: 10 });
      seedThread('orphaned', { count: 1, payload: 100 });
      seedConversation({ threadId: 'big', command: 'code' });
      seedConversation({ threadId: 'small', command: 'chat' });

      const maintenance = openCheckpointMaintenance(dbPath)!;
      const stats = maintenance.stats();
      expect(stats.dbPath).toBe(dbPath);
      expect(stats.checkpointCount).toBe(8);
      expect(stats.writeCount).toBe(8);
      expect(stats.threadCount).toBe(3);
      expect(stats.unresumableThreadCount).toBe(1);
      expect(stats.unresumableBytes).toBeGreaterThan(0);
      // The store holds the transcripts and the search index too, so the two numbers are distinct
      // and the checkpoint share is the smaller one.
      expect(stats.fileBytes).toBeGreaterThan(stats.checkpointBytes);
      expect(maintenance.diskBytes()).toBe(stats.fileBytes);
      expect(stats.largestThreads[0].threadId).toBe('big');
      expect(stats.largestThreads[0].command).toBe('code');
      expect(
        stats.largestThreads.find((t) => t.threadId === 'orphaned')?.conversationId
      ).toBeUndefined();
      maintenance.close();
    });

    /**
     * GS2-111 — `checkpointBytes` counts every pending write, so a healthy thread's attached writes
     * are inside it just as an orphan's are: subtracting `writeOnlyBytes` does NOT leave
     * checkpoint-row bytes.
     */
    it('counts the pending writes of a HEALTHY thread inside the checkpoint share', () => {
      openStore();
      seedThread('named', { count: 3, payload: 4000 });
      seedConversation({ threadId: 'named' });
      const sumOf = (sql: string): number =>
        withThread('named', (db) =>
          Number((db.prepare(sql).get() as Record<string, unknown>).bytes ?? 0)
        );
      const checkpointBlobs = sumOf(
        `SELECT COALESCE(SUM(LENGTH(checkpoint) + LENGTH(metadata)), 0) AS bytes FROM checkpoints`
      );
      const writeBlobs = sumOf(
        `SELECT COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM checkpoint_writes`
      );
      const stats = collectCheckpointStoreStats(dbPath);

      expect(stats.writeOnlyThreadCount).toBe(0);
      expect(writeBlobs).toBeGreaterThan(0);
      expect(stats.checkpointBytes).toBe(checkpointBlobs + writeBlobs);
      expect(stats.checkpointBytes).toBeGreaterThan(checkpointBlobs);
    });

    it('MUTATION CONTROL: the counts come from the rows, not from a constant', () => {
      openStore();
      seedThread('a', { count: 2 });
      seedConversation({ threadId: 'a' });
      const before = collectCheckpointStoreStats(dbPath);
      seedThread('b', { count: 7 });
      const after = collectCheckpointStoreStats(dbPath);
      expect(before.checkpointCount).toBe(2);
      expect(after.checkpointCount).toBe(9);
      expect(after.threadCount).toBe(2);
      expect(after.unresumableThreadCount).toBe(1);
    });

    it('opens nothing when there is no store, rather than creating one', () => {
      expect(openCheckpointMaintenance(join(dir, 'absent.db'))).toBeNull();
      expect(() => statSync(join(dir, 'absent.db'))).toThrow();
    });
  });
});
