/**
 * @packageDocumentation
 * GS2-121 — **the history store's migration routine**: the schema of each kind of file it is made
 * of, the ordered steps that bring a file up to that schema, and the one store-wide step that splits
 * a single-file store from an earlier release into the directory layout described in
 * `historyLayout.ts`.
 *
 * ## Per-file, versioned, on open
 *
 * Each file records its own schema version in `PRAGMA user_version`. {@link migrateFile} applies,
 * in order, every step of that file kind newer than the recorded version, each in its own
 * `BEGIN IMMEDIATE` transaction that also writes the new version, so a crash leaves the file at the
 * last step that completed and the next open carries on from there. A file whose version is NEWER
 * than any step here was written by a later release, and is refused rather than guessed at.
 *
 * A future format change is a new step appended to {@link INDEX_SCHEMA_STEPS} or
 * {@link THREAD_SCHEMA_STEPS}. It runs on the index at the next open of the store, and on each
 * thread file the next time that thread is opened, never across every thread at once.
 *
 * ## The split
 *
 * {@link splitLegacyStore} is the step from "one file holds everything" to the directory layout.
 * It is store-wide by necessity, so it is the one step with a lock, and it is written to be resumed:
 *
 * 1. Take the lock (`<store>.migrating`, created exclusively). Another process holding it means
 *    "not now": the caller treats the store as unavailable for this open, fail-soft, and a later
 *    open finds it split. A lock older than {@link STALE_LOCK_MS} is a crashed split, and is taken
 *    over.
 * 2. Settle the old file through SQLite at its own path: bring its columns up to date (what every
 *    open of it did before), fold any write-ahead log into it and switch it to a rollback journal,
 *    so the rename that follows moves one self-contained file. Then rename it to `<store>.pre-split`.
 *    From here on `<store>.pre-split` is what an interrupted split resumes from.
 * 3. Create the directory at the old path and copy each thread into its own file, one thread per
 *    transaction, with `INSERT OR IGNORE … SELECT` from the old file ATTACHed. The copy is SQLite's
 *    own, page by page: the old file is never read into this process's memory, which is what lets
 *    a multi-gigabyte store split at all. Each thread's copy is checked by row count before it
 *    commits.
 * 4. Build the index into a temporary file from the old file's conversations and turns, check its
 *    row counts, and rename it into place. The index goes last, so a reader never sees an index
 *    row whose file has not been written.
 * 5. Delete `<store>.pre-split`, then the lock.
 *
 * A conversation's home thread is the thread it names; a conversation that names none (recorded
 * without a checkpointer, or whose link was cut) is given `legacy-conversation-<id>`, which is
 * deterministic, so a resumed split puts it in the same file the first attempt did.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { historyStorePaths, threadFilePath } from '#src/history/historyLayout.js';

/**
 * How long a statement waits for another connection's lock before giving up. The recorder, the
 * checkpoint saver and a second terminal all reach the same files, so an overlap is ordinary and
 * must wait rather than surface as `SQLITE_BUSY`.
 */
export const HISTORY_BUSY_TIMEOUT_MS = 5000;

/**
 * A split's lock older than this is a crashed split. The lock's time is refreshed after every
 * thread, and one thread's copy is a single `INSERT … SELECT`, so a live split never goes this
 * long without touching it.
 */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/** One ordered step of a file's schema. */
export interface SchemaStep {
  /** The `user_version` the file has once this step has run. Strictly increasing. */
  version: number;
  /** What the step does, for a reader of this list. */
  describe: string;
  /** Apply the step. Runs inside a transaction; must be idempotent (`IF NOT EXISTS`). */
  up(db: DatabaseSync): void;
}

/**
 * The conversations/sessions/FTS schema, shared by the index and by an old single-file store. The
 * index adds `home_thread`; an old store never had it.
 */
const conversationTablesDdl = (extraConversationColumns = ''): string => `
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_ts TEXT NOT NULL,
    project TEXT,
    command TEXT,
    model TEXT,
    thread_id TEXT,
    grants TEXT,
    run_id TEXT,
    origin TEXT${extraConversationColumns}
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    project TEXT,
    command TEXT,
    model TEXT,
    prompt TEXT,
    response TEXT,
    tokens_input INTEGER,
    tokens_output INTEGER,
    cost_usd REAL,
    tools TEXT,
    duration_ms INTEGER,
    conversation_id INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    prompt, response, command, project
  );
`;

/** The checkpoint tables, shared by a thread file and by an old single-file store. */
const CHECKPOINT_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_checkpoint_id TEXT,
    type TEXT,
    checkpoint BLOB,
    metadata BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  );
  CREATE TABLE IF NOT EXISTS checkpoint_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT,
    value BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  );
`;

/**
 * The index's schema. `home_thread` names the thread file holding the conversation's durable
 * record; `thread_id` is the resume link, which may be cut (set NULL) while the home stays.
 */
export const INDEX_SCHEMA_STEPS: readonly SchemaStep[] = Object.freeze([
  {
    version: 1,
    describe: 'conversations, sessions and their full-text index, with each conversation home file',
    up(db: DatabaseSync) {
      db.exec(conversationTablesDdl(',\n    home_thread TEXT'));
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_conversations_thread_id ON conversations(thread_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_run_id ON conversations(run_id);
        CREATE INDEX IF NOT EXISTS idx_conversations_home_thread ON conversations(home_thread);
        CREATE INDEX IF NOT EXISTS idx_sessions_conversation_id ON sessions(conversation_id);
      `);
    },
  },
]);

/**
 * A thread file's schema: the thread's checkpoint tables, its own id, and the durable record of
 * every conversation whose home it is.
 */
export const THREAD_SCHEMA_STEPS: readonly SchemaStep[] = Object.freeze([
  {
    version: 1,
    describe: 'checkpoints and pending writes of one thread, and its conversations and turns',
    up(db: DatabaseSync) {
      db.exec(CHECKPOINT_TABLES_DDL);
      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_records (
          id INTEGER PRIMARY KEY,
          started_ts TEXT NOT NULL,
          project TEXT,
          command TEXT,
          model TEXT,
          thread_id TEXT,
          grants TEXT,
          run_id TEXT,
          origin TEXT
        );
        CREATE TABLE IF NOT EXISTS turn_records (
          id INTEGER PRIMARY KEY,
          ts TEXT NOT NULL,
          project TEXT,
          command TEXT,
          model TEXT,
          prompt TEXT,
          response TEXT,
          tokens_input INTEGER,
          tokens_output INTEGER,
          cost_usd REAL,
          tools TEXT,
          duration_ms INTEGER,
          conversation_id INTEGER
        );
      `);
    },
  },
]);

/** The schema version a file records. */
export function fileSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Bring one open file up to the newest step of `steps`. Throws when the file is newer than every
 * step (written by a later release) or a step fails; the caller's open is fail-soft.
 */
export function migrateFile(db: DatabaseSync, steps: readonly SchemaStep[]): void {
  const latest = steps[steps.length - 1].version;
  const recorded = fileSchemaVersion(db);
  if (recorded > latest) {
    throw new Error(
      `History file schema version ${recorded} is newer than this release knows (${latest}).`
    );
  }
  if (recorded === latest) return;
  for (const step of steps) {
    // Re-read under the write lock: another process may have run this step since the read above.
    db.exec('BEGIN IMMEDIATE');
    try {
      if (fileSchemaVersion(db) < step.version) {
        step.up(db);
        db.exec(`PRAGMA user_version = ${step.version}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the failed statement may already have ended the transaction */
      }
      throw error;
    }
  }
}

/** Open a connection with the store's busy timeout. */
export function openConnection(path: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const db = options.readOnly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${HISTORY_BUSY_TIMEOUT_MS}`);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
  return db;
}

/** Close a connection, ignoring a connection that is already broken or closed. */
export function closeQuietly(db: DatabaseSync | undefined): void {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}

/**
 * Bring an OLD single-file store's conversation tables up to the last shape that format had, in
 * place: the columns later releases added, and one conversation per ungrouped turn. It is what
 * every open of such a file did before the split, and the split reads the file in that shape.
 */
function upgradeLegacyStore(db: DatabaseSync): void {
  db.exec(conversationTablesDdl());
  db.exec(CHECKPOINT_TABLES_DDL);
  const columnsOf = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).map((c) =>
        String(c.name)
      )
    );
  const sessionCols = columnsOf('sessions');
  if (!sessionCols.has('conversation_id')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN conversation_id INTEGER`);
  }
  const conversationCols = columnsOf('conversations');
  for (const [column, type] of [
    ['thread_id', 'TEXT'],
    ['grants', 'TEXT'],
    ['run_id', 'TEXT'],
    ['origin', 'TEXT'],
  ] as const) {
    if (!conversationCols.has(column)) {
      db.exec(`ALTER TABLE conversations ADD COLUMN ${column} ${type}`);
    }
  }
  const orphans = db
    .prepare(
      `SELECT id, ts, project, command, model FROM sessions
        WHERE conversation_id IS NULL ORDER BY id`
    )
    .all() as Record<string, unknown>[];
  if (orphans.length === 0) return;
  db.exec('BEGIN');
  try {
    const insertConversation = db.prepare(
      `INSERT INTO conversations (started_ts, project, command, model, run_id)
       VALUES (?, ?, ?, ?, ?)`
    );
    const stampTurn = db.prepare(`UPDATE sessions SET conversation_id = ? WHERE id = ?`);
    for (const row of orphans) {
      const info = insertConversation.run(
        row.ts != null ? String(row.ts) : new Date().toISOString(),
        row.project != null ? String(row.project) : null,
        row.command != null ? String(row.command) : null,
        row.model != null ? String(row.model) : null,
        randomUUID()
      );
      stampTurn.run(Number(info.lastInsertRowid), Number(row.id));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The prefix of the home thread the split gives a conversation that names no thread. */
const LEGACY_HOME_PREFIX = 'legacy-conversation-';

/** The home thread the split gives a conversation that names no thread. Deterministic on purpose. */
export function legacyHomeThread(conversationId: number): string {
  return `${LEGACY_HOME_PREFIX}${conversationId}`;
}

/** Take the split's lock, or answer false when a live split holds it. */
function acquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      let age = 0;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between the two calls: try again
      }
      if (age < STALE_LOCK_MS) return false;
      try {
        rmSync(lockPath, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

/** Refresh the lock's time, so a long split is not mistaken for a crashed one. */
function touchLock(lockPath: string): void {
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    /* the lock is advisory; a failed touch at worst lets a stale-lock check fire early */
  }
}

/** Open a thread file for the split, migrated and stamped with its thread id. */
function openSplitThreadFile(storePath: string, threadId: string): DatabaseSync {
  const db = openConnection(threadFilePath(storePath, threadId));
  try {
    migrateFile(db, THREAD_SCHEMA_STEPS);
    db.prepare(`INSERT OR IGNORE INTO thread_meta (key, value) VALUES ('thread_id', ?)`).run(
      threadId
    );
    return db;
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

/** A count from a one-row `COUNT(*) AS n` query. */
function count(db: DatabaseSync, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  return Number(row?.n ?? 0);
}

/** Copy one thread, and every conversation whose home it is, out of the ATTACHed old file. */
function copyThread(
  storePath: string,
  preSplit: string,
  threadId: string,
  homedConversations: readonly number[]
): void {
  const db = openSplitThreadFile(storePath, threadId);
  try {
    db.prepare(`ATTACH DATABASE ? AS legacy`).run(preSplit);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          `INSERT OR IGNORE INTO main.checkpoints
             (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
              metadata)
           SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint,
                  metadata
             FROM legacy.checkpoints WHERE thread_id = ?`
        ).run(threadId);
        db.prepare(
          `INSERT OR IGNORE INTO main.checkpoint_writes
             (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
           SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value
             FROM legacy.checkpoint_writes WHERE thread_id = ?`
        ).run(threadId);
        const copyConversation = db.prepare(
          `INSERT OR IGNORE INTO main.conversation_records
             (id, started_ts, project, command, model, thread_id, grants, run_id, origin)
           SELECT id, started_ts, project, command, model, thread_id, grants, run_id, origin
             FROM legacy.conversations WHERE id = ?`
        );
        const copyTurns = db.prepare(
          `INSERT OR IGNORE INTO main.turn_records
             (id, ts, project, command, model, prompt, response, tokens_input, tokens_output,
              cost_usd, tools, duration_ms, conversation_id)
           SELECT id, ts, project, command, model, prompt, response, tokens_input, tokens_output,
                  cost_usd, tools, duration_ms, conversation_id
             FROM legacy.sessions WHERE conversation_id = ?`
        );
        for (const id of homedConversations) {
          copyConversation.run(id);
          copyTurns.run(id);
        }
        // The check that makes the delete of the old file safe: this file now holds every row the
        // old file had for this thread. A file resumed after a crash already held some of them,
        // which `OR IGNORE` skipped, so the comparison is of totals, not of what this pass added.
        const expectedCheckpoints = count(
          db,
          `SELECT COUNT(*) AS n FROM legacy.checkpoints WHERE thread_id = ?`,
          threadId
        );
        const expectedWrites = count(
          db,
          `SELECT COUNT(*) AS n FROM legacy.checkpoint_writes WHERE thread_id = ?`,
          threadId
        );
        const copiedCheckpoints = count(
          db,
          `SELECT COUNT(*) AS n FROM main.checkpoints WHERE thread_id = ?`,
          threadId
        );
        const copiedWrites = count(
          db,
          `SELECT COUNT(*) AS n FROM main.checkpoint_writes WHERE thread_id = ?`,
          threadId
        );
        if (expectedCheckpoints !== copiedCheckpoints || expectedWrites !== copiedWrites) {
          throw new Error(`The split of thread ${threadId} did not copy every row.`);
        }
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already unwound */
        }
        throw error;
      }
    } finally {
      db.exec('DETACH DATABASE legacy');
    }
  } finally {
    closeQuietly(db);
  }
}

/** Build the index from the ATTACHed old file into `target`, checking its row counts. */
function buildIndexFromLegacy(target: string, preSplit: string): void {
  rmSync(target, { force: true });
  rmSync(`${target}-journal`, { force: true });
  const db = openConnection(target);
  try {
    migrateFile(db, INDEX_SCHEMA_STEPS);
    db.prepare(`ATTACH DATABASE ? AS legacy`).run(preSplit);
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(
          `INSERT INTO main.conversations
             (id, started_ts, project, command, model, thread_id, grants, run_id, origin,
              home_thread)
           SELECT id, started_ts, project, command, model, thread_id, grants, run_id, origin,
                  CASE WHEN thread_id IS NULL OR thread_id = ''
                       THEN ? || id ELSE thread_id END
             FROM legacy.conversations`
        ).run(LEGACY_HOME_PREFIX);
        db.exec(
          `INSERT INTO main.sessions
             (id, ts, project, command, model, prompt, response, tokens_input, tokens_output,
              cost_usd, tools, duration_ms, conversation_id)
           SELECT id, ts, project, command, model, prompt, response, tokens_input, tokens_output,
                  cost_usd, tools, duration_ms, conversation_id
             FROM legacy.sessions`
        );
        db.exec(
          `INSERT INTO main.sessions_fts (rowid, prompt, response, command, project)
           SELECT id, COALESCE(prompt, ''), COALESCE(response, ''), COALESCE(command, ''),
                  COALESCE(project, '')
             FROM legacy.sessions`
        );
        const conversations = count(db, `SELECT COUNT(*) AS n FROM legacy.conversations`);
        const sessions = count(db, `SELECT COUNT(*) AS n FROM legacy.sessions`);
        if (
          count(db, `SELECT COUNT(*) AS n FROM main.conversations`) !== conversations ||
          count(db, `SELECT COUNT(*) AS n FROM main.sessions`) !== sessions
        ) {
          throw new Error('The split did not copy every conversation into the index.');
        }
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* already unwound */
        }
        throw error;
      }
    } finally {
      db.exec('DETACH DATABASE legacy');
    }
  } finally {
    closeQuietly(db);
  }
}

/**
 * Split the single-file store at `storePath` (or resume a split interrupted part-way) into the
 * directory layout. Returns `true` when the store is in the directory layout afterwards, `false`
 * when it could not be split now: another process holds the lock, the old file will not open, or a
 * copy failed its check. On `false` nothing has been lost: the old data is still at `storePath` or
 * at `<store>.pre-split`, and the next open tries again. Never throws.
 */
export function splitLegacyStore(storePath: string): boolean {
  const paths = historyStorePaths(storePath);
  if (!acquireLock(paths.lock)) return false;
  try {
    const current = statKind(storePath);
    if (current === 'file') {
      // A file here AND a half-split beside it is two stores; merging them is not a guess to make
      // on a user's behalf, so this open leaves both alone.
      if (existsSync(paths.preSplit)) return false;
      const legacy = openConnection(storePath);
      try {
        upgradeLegacyStore(legacy);
        legacy.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        legacy.exec('PRAGMA journal_mode = DELETE');
      } finally {
        closeQuietly(legacy);
      }
      renameSync(storePath, paths.preSplit);
    }
    if (!existsSync(paths.preSplit)) return statKind(storePath) === 'directory';

    if (statKind(storePath) === 'absent') mkdirSync(storePath);
    if (statKind(paths.threads) === 'absent') mkdirSync(paths.threads);

    // Which conversation lives in which thread file. Conversation rows only, never a blob.
    const source = openConnection(paths.preSplit, { readOnly: true });
    const homes = new Map<string, number[]>();
    try {
      for (const row of source
        .prepare(`SELECT id, thread_id FROM conversations ORDER BY id`)
        .all() as Record<string, unknown>[]) {
        const id = Number(row.id);
        const threadId =
          row.thread_id != null && String(row.thread_id).length > 0
            ? String(row.thread_id)
            : legacyHomeThread(id);
        const list = homes.get(threadId) ?? [];
        list.push(id);
        homes.set(threadId, list);
      }
      for (const row of source
        .prepare(
          `SELECT thread_id FROM checkpoints GROUP BY thread_id
           UNION SELECT thread_id FROM checkpoint_writes GROUP BY thread_id`
        )
        .all() as Record<string, unknown>[]) {
        const threadId = String(row.thread_id);
        if (threadId.length > 0 && !homes.has(threadId)) homes.set(threadId, []);
      }
    } finally {
      closeQuietly(source);
    }

    for (const threadId of [...homes.keys()].sort()) {
      copyThread(storePath, paths.preSplit, threadId, homes.get(threadId)!);
      touchLock(paths.lock);
    }

    const staged = `${paths.index}.split-tmp`;
    buildIndexFromLegacy(staged, paths.preSplit);
    renameSync(staged, paths.index);
    rmSync(paths.preSplit, { force: true });
    rmSync(`${paths.preSplit}-journal`, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(paths.lock, { force: true });
  }
}

/** What is at `path`: a regular file, a directory, nothing, or something else. */
export function statKind(path: string): 'file' | 'directory' | 'absent' | 'other' {
  try {
    const stats = lstatSync(path);
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return 'other';
  } catch {
    return 'absent';
  }
}
