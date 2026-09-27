/**
 * GS2-121 — the acceptance of the split history store: an index plus one SQLite file per thread
 * (and one per conversation record), with the index a cache the files can rebuild.
 *
 * Each `describe` below pins one line of the node's acceptance or one of its rules. The properties
 * that are about processes (another process's lock, a heap cap, the vitest guard seeing a write)
 * run in child processes through `fixtures/historySplitChild.mjs`.
 *
 * Every store here is built under a temp dir, and every child that could resolve a path from `HOME`
 * is given a temp `HOME`. Nothing here can reach the developer's `~/.gsloth/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openHistoryStore, rebuildHistoryIndexSafe } from '#src/history/historyStore.js';
import { openCheckpointSaver } from '#src/history/checkpointSaver.js';
import { openThreadDb } from '#src/history/historyFiles.js';
import { HISTORY_BUSY_TIMEOUT_MS } from '#src/history/historyMigrations.js';
import {
  countRows,
  indexPath,
  threadFilePathOf,
  threadFiles,
} from './fixtures/historyStoreFiles.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/historySplitChild.mjs', import.meta.url));

interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Run the child fixture in its own process, without blocking this one's event loop. */
function runChild(
  args: string[],
  options: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv } = {}
): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...(options.nodeArgs ?? []), CHILD, ...args], {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

/** The one JSON line a child printed. */
const reportOf = (result: ChildResult): Record<string, unknown> => {
  const line = result.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    throw new Error(`child printed no report: status ${result.status}, stderr: ${result.stderr}`);
  }
};

/** The schema a 2.0.0 single-file store has on disk. */
const LEGACY_DDL = `
  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, started_ts TEXT NOT NULL, project TEXT, command TEXT,
    model TEXT, thread_id TEXT, grants TEXT, run_id TEXT, origin TEXT);
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project TEXT, command TEXT, model TEXT,
    prompt TEXT, response TEXT, tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL,
    tools TEXT, duration_ms INTEGER, conversation_id INTEGER);
  CREATE VIRTUAL TABLE sessions_fts USING fts5(prompt, response, command, project);
  CREATE TABLE checkpoints (
    thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
  CREATE TABLE checkpoint_writes (
    thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
`;

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/**
 * A small single-file store as 2.0.0 wrote it: one conversation (#1, run id `run-legacy`) naming
 * `legacy-thread`, which holds two checkpoints in the serializer's JSON shape and one pending
 * write, and one turn.
 */
function writeLegacyStore(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(LEGACY_DDL);
    db.prepare(
      `INSERT INTO conversations (id, started_ts, project, command, model, thread_id, run_id)
       VALUES (1, '2026-09-01T00:00:00.000Z', '/work', 'code', 'm', 'legacy-thread', 'run-legacy')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, ts, project, command, model, prompt, response, conversation_id)
       VALUES (1, '2026-09-01T00:00:01.000Z', '/work', 'code', 'm', 'legacy needle', 'answer', 1)`
    ).run();
    db.prepare(
      `INSERT INTO sessions_fts (rowid, prompt, response, command, project)
       VALUES (1, 'legacy needle', 'answer', 'code', '/work')`
    ).run();
    const checkpoint = db.prepare(
      `INSERT INTO checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
       VALUES ('legacy-thread', '', ?, ?, 'json', ?, ?)`
    );
    for (const [id, parent, value] of [
      ['cp-1', null, 'first'],
      ['cp-2', 'cp-1', 'hello from before the split'],
    ] as const) {
      checkpoint.run(
        id,
        parent,
        encode({
          v: 4,
          id,
          ts: '2026-09-01T00:00:00.000Z',
          channel_values: { messages: value },
          channel_versions: {},
          versions_seen: {},
        }),
        encode({ source: 'loop', step: 0, parents: {} })
      );
    }
    db.prepare(
      `INSERT INTO checkpoint_writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES ('legacy-thread', '', 'cp-2', 'task-1', 0, '__interrupt__', 'json', ?)`
    ).run(encode('suspended'));
  } finally {
    db.close();
  }
}

/** One checkpoint for `threadId`, through the real saver. */
async function putCheckpoint(storePath: string, threadId: string, value = 'state'): Promise<void> {
  const saver = openCheckpointSaver(storePath)!;
  try {
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      {
        v: 4,
        id: `cp-${threadId}`,
        ts: new Date().toISOString(),
        channel_values: { messages: value },
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'loop', step: 0, parents: {} },
      {}
    );
  } finally {
    saver.close();
  }
}

/** The file of one conversation's record, found through the index. */
function recordFileOf(storePath: string, conversationId: number): string {
  const db = new DatabaseSync(indexPath(storePath), { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT home_thread FROM conversations WHERE id = ?`)
      .get(conversationId) as { home_thread: string };
    const path = threadFilePathOf(storePath, row.home_thread);
    if (path === undefined) throw new Error(`no record file for #${conversationId}`);
    return path;
  } finally {
    db.close();
  }
}

describe('GS2-121 — the split history store', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsloth-split-'));
    dbPath = join(dir, 'history.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('rule 1 — the index is a cache the files rebuild', () => {
    /** Everything a reader can ask the store about its conversations. */
    const snapshot = () => {
      const store = openHistoryStore(dbPath)!;
      try {
        return {
          list: store.listConversations(50),
          each: store.listConversations(50).map((c) => ({
            id: c.id,
            summary: store.getConversation(c.id),
            turns: store.getConversationThread(c.id),
            thread: store.getConversationThreadId(c.id),
            grants: store.getConversationGrants(c.id),
          })),
          search: store.search('needle'),
          byRun: store
            .listConversations(50)
            .map((c) => store.resolveConversationRef({ kind: 'run', runId: String(c.runId) })),
        };
      } finally {
        store.close();
      }
    };

    it('ACCEPTANCE: the index rebuilds from the files alone — ids, run ids, links, grants, turns and search come back as they were', async () => {
      const store = openHistoryStore(dbPath, { create: true })!;
      const resumable = store.openConversation({ command: 'code', threadId: 'thread-kept' })!;
      store.record({
        conversationId: resumable,
        command: 'code',
        prompt: 'a needle',
        response: 'r1',
      });
      store.record({
        conversationId: resumable,
        command: 'code',
        prompt: 'second',
        response: 'r2',
      });
      store.setConversationGrants(resumable, '{"version":1,"allow":[],"deny":[]}');
      const unthreaded = store.record({ command: 'ask', prompt: 'no thread', response: 'r' })!;
      const cut = store.openConversation({ command: 'code', threadId: 'thread-cut' })!;
      store.record({ conversationId: cut, command: 'code', prompt: 'cut needle', response: 'r' });
      store.close();
      await putCheckpoint(dbPath, 'thread-kept');
      await putCheckpoint(dbPath, 'thread-cut');
      // What a failed checkpoint write records: the link is gone in the index AND in the record.
      const cutter = openHistoryStore(dbPath)!;
      cutter.clearConversationThread(cut);
      cutter.close();

      const before = snapshot();
      expect(before.list).toHaveLength(3);
      expect(before.each.find((c) => c.id === resumable)!.thread).toBe('thread-kept');
      expect(before.each.find((c) => c.id === cut)!.thread).toBeNull();
      expect(before.search.length).toBe(2);
      expect(unthreaded).toBeGreaterThan(0);

      // The index is gone; only the files are left.
      rmSync(indexPath(dbPath));
      const summary = rebuildHistoryIndexSafe(dbPath)!;
      expect(summary).toMatchObject({ conversations: 3, turns: 4, unreadable: 0 });

      expect(snapshot()).toEqual(before);
    });

    it('a missing index is rebuilt on the next open, with no command', async () => {
      const store = openHistoryStore(dbPath, { create: true })!;
      const id = store.openConversation({ command: 'code', threadId: 'thread-a' })!;
      store.record({ conversationId: id, command: 'code', prompt: 'p', response: 'r' });
      store.close();
      rmSync(indexPath(dbPath));

      const reopened = openHistoryStore(dbPath)!;
      expect(reopened.getConversationThreadId(id)).toBe('thread-a');
      reopened.close();
    });
  });

  describe('deleting one file loses only what it held', () => {
    let a: number;
    let b: number;

    beforeEach(async () => {
      const store = openHistoryStore(dbPath, { create: true })!;
      a = store.openConversation({ command: 'code', threadId: 'thread-a' })!;
      store.record({ conversationId: a, command: 'code', prompt: 'pa', response: 'ra' });
      b = store.openConversation({ command: 'code', threadId: 'thread-b' })!;
      store.record({ conversationId: b, command: 'code', prompt: 'pb', response: 'rb' });
      store.close();
      await putCheckpoint(dbPath, 'thread-a', 'state of a');
      await putCheckpoint(dbPath, 'thread-b', 'state of b');
    });

    it("ACCEPTANCE: deleting one THREAD file loses that thread's state and nothing else", async () => {
      rmSync(threadFilePathOf(dbPath, 'thread-a')!);

      const store = openHistoryStore(dbPath)!;
      // The index row naming the missing file is dropped as a link: listed, readable, not resumable.
      expect(store.getConversationThreadId(a)).toBeNull();
      expect(store.getConversationThread(a).map((t) => t.prompt)).toEqual(['pa']);
      // …and the other conversation is untouched.
      expect(store.getConversationThreadId(b)).toBe('thread-b');
      store.close();

      const saver = openCheckpointSaver(dbPath)!;
      expect(await saver.getTuple({ configurable: { thread_id: 'thread-a' } })).toBeUndefined();
      const survivor = await saver.getTuple({ configurable: { thread_id: 'thread-b' } });
      expect(survivor?.checkpoint.channel_values).toEqual({ messages: 'state of b' });
      saver.close();
      // A read of the missing thread created nothing.
      expect(threadFilePathOf(dbPath, 'thread-a')).toBeUndefined();
    });

    it("deleting one conversation's RECORD file drops that conversation at the next rebuild, and only it", () => {
      rmSync(recordFileOf(dbPath, a));
      expect(rebuildHistoryIndexSafe(dbPath)).toMatchObject({ conversations: 1 });

      const store = openHistoryStore(dbPath)!;
      expect(store.getConversation(a)).toBeNull();
      expect(store.getConversationThreadId(b)).toBe('thread-b');
      expect(store.getConversationThread(b).map((t) => t.prompt)).toEqual(['pb']);
      store.close();
      // Its thread's state is untouched, and is now an orphan for retention to reclaim.
      expect(countRows(dbPath, 'checkpoints', 'thread-a')).toBe(1);
    });
  });

  /**
   * The acceptance line is "two processes writing different threads do not contend on one lock".
   * One process holds a write transaction open on thread A's file — what a saver mid-commit in
   * another window is — and a second process writes through the real saver.
   *
   * What this does NOT cover, stated: conversation and turn rows are written through the index, so
   * two processes recording turns at the same moment still take the index's lock in turn. Those
   * writes are a row each and commit in milliseconds; the checkpoint state, which is what grew to
   * gigabytes, no longer shares a lock.
   */
  describe('two processes writing different threads', () => {
    let holder: DatabaseSync;
    let fileA: string;

    beforeEach(async () => {
      openHistoryStore(dbPath, { create: true })!.close();
      await putCheckpoint(dbPath, 'thread-a');
      fileA = threadFilePathOf(dbPath, 'thread-a')!;
      holder = new DatabaseSync(fileA);
      holder.exec('BEGIN IMMEDIATE');
      holder.exec(`INSERT INTO thread_meta (key, value) VALUES ('held', 'by another process')`);
    });
    afterEach(() => {
      try {
        holder.exec('ROLLBACK');
      } catch {
        /* already released */
      }
      holder.close();
    });

    it('ACCEPTANCE: a write to thread B lands at once while another process holds thread A', async () => {
      const report = reportOf(await runChild(['put', dbPath, 'thread-b']));
      expect(report.failures).toEqual([]);
      // Well inside the busy timeout: it never waited on A's lock.
      expect(report.ms as number).toBeLessThan(HISTORY_BUSY_TIMEOUT_MS / 2);
      expect(countRows(dbPath, 'checkpoints', 'thread-b')).toBe(1);
    }, 30_000);

    it('CONTROL: the same saver writing thread A waits out the busy timeout and fails — the lock is real', async () => {
      const report = reportOf(await runChild(['put', dbPath, 'thread-a']));
      expect(report.failures as string[]).toHaveLength(1);
      expect(report.ms as number).toBeGreaterThanOrEqual(HISTORY_BUSY_TIMEOUT_MS - 1000);
      // A raw writer with no timeout is refused at once, by SQLite, on the same file.
      const raw = reportOf(await runChild(['raw-write', fileA]));
      expect(raw).toMatchObject({ ok: false });
      expect(String(raw.error)).toMatch(/locked|busy/i);
    }, 30_000);
  });

  describe('the split of a single-file store', () => {
    it('ACCEPTANCE: resume through the index still works after a split — run id, thread, checkpoint and pending write', async () => {
      writeLegacyStore(dbPath);
      const store = openHistoryStore(dbPath)!;
      expect(statSync(dbPath).isDirectory()).toBe(true);
      const id = store.resolveConversationRef({ kind: 'run', runId: 'run-legacy' });
      expect(id).toBe(1);
      const threadId = store.getConversationThreadId(id!);
      expect(threadId).toBe('legacy-thread');
      expect(store.search('needle').map((r) => r.prompt)).toEqual(['legacy needle']);
      store.close();

      const saver = openCheckpointSaver(dbPath)!;
      const tuple = await saver.getTuple({ configurable: { thread_id: threadId! } });
      saver.close();
      expect(tuple?.checkpoint.id).toBe('cp-2');
      expect(tuple?.checkpoint.channel_values).toEqual({ messages: 'hello from before the split' });
      expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('cp-1');
      expect(tuple?.pendingWrites?.map(([, channel, value]) => [channel, value])).toEqual([
        ['__interrupt__', 'suspended'],
      ]);
      // The old file is gone, and nothing is left beside the store.
      expect(existsSync(`${dbPath}.pre-split`)).toBe(false);
      expect(existsSync(`${dbPath}.migrating`)).toBe(false);
    });

    it('an interrupted split resumes from the renamed file and finishes, a half-copied thread included', () => {
      writeLegacyStore(dbPath);
      // The state a crash leaves after the rename and part of the copy: the old file under its
      // split name, the store directory, and a thread file holding one of its two checkpoints.
      renameSync(dbPath, `${dbPath}.pre-split`);
      mkdirSync(join(dbPath, 'threads'), { recursive: true });
      const partial = openThreadDb(dbPath, 'legacy-thread', { create: true })!;
      partial
        .prepare(
          `INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata)
           VALUES ('legacy-thread', '', 'cp-1', 'json', x'7b7d', x'7b7d')`
        )
        .run();
      partial.close();

      const store = openHistoryStore(dbPath)!;
      expect(store.getConversationThreadId(1)).toBe('legacy-thread');
      store.close();
      expect(countRows(dbPath, 'checkpoints', 'legacy-thread')).toBe(2);
      expect(existsSync(`${dbPath}.pre-split`)).toBe(false);
    });

    it("a live split's lock is respected, and a stale one is taken over", () => {
      writeLegacyStore(dbPath);
      writeFileSync(`${dbPath}.migrating`, 'another process\n');
      // Another process has been splitting for five minutes, inside the stale limit: a long split
      // still in progress. This open leaves the file alone and reports no store.
      const recent = new Date(Date.now() - 5 * 60 * 1000);
      utimesSync(`${dbPath}.migrating`, recent, recent);
      expect(openHistoryStore(dbPath)).toBeNull();
      expect(existsSync(`${dbPath}.migrating`)).toBe(true);
      expect(statSync(dbPath).isFile()).toBe(true);

      // The same lock, abandoned long ago: taken over, and the split completes.
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(`${dbPath}.migrating`, old, old);
      const store = openHistoryStore(dbPath)!;
      expect(store).not.toBeNull();
      expect(store.getConversationThreadId(1)).toBe('legacy-thread');
      store.close();
      expect(existsSync(`${dbPath}.migrating`)).toBe(false);
    });

    it('a file from a newer release is refused, not rewritten', () => {
      openHistoryStore(dbPath, { create: true })!.close();
      const index = new DatabaseSync(indexPath(dbPath));
      index.exec('PRAGMA user_version = 99');
      index.close();
      const size = statSync(indexPath(dbPath)).size;

      expect(openHistoryStore(dbPath)).toBeNull();
      const check = new DatabaseSync(indexPath(dbPath), { readOnly: true });
      expect(check.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 });
      check.close();
      expect(statSync(indexPath(dbPath)).size).toBe(size);
    });

    /**
     * The node's line: the split must not load a whole old file into memory (Andrew's was over
     * 2 GB). A streamed stand-in: a 48 MB store of incompressible 1 MB checkpoints, split by a
     * process whose V8 heap is capped at 16 MB. The CONTROL is the same cap on a process that reads
     * the checkpoints into the heap, which is killed — so the cap is one a whole read cannot fit.
     */
    it('ACCEPTANCE: splits a store three times larger than the heap it is given, which a whole read cannot fit', async () => {
      const CAP_MB = 16;
      const CHECKPOINTS = 48;
      const legacy = new DatabaseSync(dbPath);
      legacy.exec(LEGACY_DDL);
      legacy.exec(`
          BEGIN;
          WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${CHECKPOINTS - 1})
          INSERT INTO checkpoints (thread_id, checkpoint_id, type, checkpoint, metadata)
            SELECT 'big-' || (i % 4), printf('ckpt-%06d', i), 'json', randomblob(1048576), x'7b7d'
              FROM n;
          INSERT INTO conversations (started_ts, command, thread_id, run_id)
            VALUES ('2026-09-01', 'code', 'big-0', 'run-big');
          COMMIT;
        `);
      const bytes = Number(
        (
          legacy.prepare(`SELECT SUM(LENGTH(checkpoint)) AS n FROM checkpoints`).get() as Record<
            string,
            unknown
          >
        ).n
      );
      legacy.close();
      expect(statSync(dbPath).size).toBeGreaterThan(3 * CAP_MB * 1024 * 1024);

      const nodeArgs = [`--max-old-space-size=${CAP_MB}`];
      const control = await runChild(['slurp', dbPath], { nodeArgs });
      expect(control.status).not.toBe(0);
      expect(control.stderr).toMatch(/heap/i);

      const split = await runChild(['split', dbPath], { nodeArgs });
      expect(split.status).toBe(0);
      expect(reportOf(split)).toMatchObject({ ok: true });

      expect(statSync(dbPath).isDirectory()).toBe(true);
      expect(countRows(dbPath, 'checkpoints')).toBe(CHECKPOINTS);
      let copied = 0;
      for (const file of threadFiles(dbPath)) {
        const db = new DatabaseSync(file.path, { readOnly: true });
        copied += Number(
          (
            db
              .prepare(`SELECT COALESCE(SUM(LENGTH(checkpoint)), 0) AS n FROM checkpoints`)
              .get() as Record<string, unknown>
          ).n
        );
        db.close();
      }
      expect(copied).toBe(bytes);
      expect(countRows(dbPath, 'conversations')).toBe(1);
    }, 120_000);
  });

  /**
   * The vitest guard fingerprints the developer's real store; after the split that store can be a
   * directory, or an old file a first open would split. Run in a child with a temp HOME holding an
   * old file: the guard must object when that file is split, and not otherwise.
   */
  describe('the vitest history guard still guards', () => {
    let home: string;
    const envFor = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, USERPROFILE: home });

    beforeEach(() => {
      home = join(dir, 'home');
      mkdirSync(join(home, '.gsloth'), { recursive: true });
      writeLegacyStore(join(home, '.gsloth', 'history.db'));
    });

    it('objects when a run splits the old single file under HOME', async () => {
      const report = reportOf(await runChild(['guard', 'split'], { env: envFor() }));
      expect(report.objected).toBe(true);
      // The control that the split happened, so the objection is about it.
      expect(statSync(join(home, '.gsloth', 'history.db')).isDirectory()).toBe(true);
    });

    it('objects to a write deep inside a store that is already a directory', async () => {
      // Split first, outside the guard's window, so the only change it can see is the new file.
      const { splitLegacyStore } = await import('#src/history/historyMigrations.js');
      expect(splitLegacyStore(join(home, '.gsloth', 'history.db'))).toBe(true);
      const report = reportOf(await runChild(['guard', 'record'], { env: envFor() }));
      expect(report.objected).toBe(true);
    });

    it('CONTROL: stays quiet when nothing touches it', async () => {
      const report = reportOf(await runChild(['guard', 'none'], { env: envFor() }));
      expect(report.objected).toBe(false);
    });
  });
});
