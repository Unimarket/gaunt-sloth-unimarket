/**
 * @packageDocumentation
 * GS2-121 — opening the files the history store is made of. Every opener in the history modules
 * comes through here, so the rules in `historyLayout.ts` (a single-file store is split on first
 * open, every file is migrated when opened, a missing index is rebuilt from the thread files) apply
 * to all of them at once.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  historyStorePaths,
  isThreadFileName,
  threadFilePath,
  threadIdFromFileName,
} from '#src/history/historyLayout.js';
import {
  INDEX_SCHEMA_STEPS,
  THREAD_SCHEMA_STEPS,
  closeQuietly,
  migrateFile,
  openConnection,
  splitLegacyStore,
  statKind,
} from '#src/history/historyMigrations.js';

/**
 * What an open found:
 * - `ready` — the store is a directory in the current layout (possibly just split into it);
 * - `absent` — nothing is there and the caller did not ask to create it;
 * - `unavailable` — something is there that cannot be used now: a split another process is
 *   running, an old file that would not open, or a path that is neither a file nor a directory.
 */
export type HistoryStoreState = 'ready' | 'absent' | 'unavailable';

/**
 * Make the store at `storePath` ready to open: split a single-file store (or finish a split that
 * was interrupted), and with `create`, create the store directory and `threads/`. The directory
 * is created WITHOUT its parents, so a path under a directory that does not exist is refused.
 * Never throws.
 */
export function prepareHistoryStore(
  storePath: string,
  options: { create?: boolean } = {}
): HistoryStoreState {
  try {
    const paths = historyStorePaths(storePath);
    let kind = statKind(storePath);
    if (kind === 'file' || existsSync(paths.preSplit)) {
      if (!splitLegacyStore(storePath)) return 'unavailable';
      kind = statKind(storePath);
    }
    if (kind === 'directory') {
      if (options.create && statKind(paths.threads) === 'absent') mkdirSync(paths.threads);
      return 'ready';
    }
    if (kind !== 'absent') return 'unavailable';
    if (!options.create) return 'absent';
    mkdirSync(storePath);
    mkdirSync(paths.threads);
    return 'ready';
  } catch {
    return 'unavailable';
  }
}

/** One file in `threads/`. */
export interface ThreadFileEntry {
  /** The file's name inside `threads/`. */
  name: string;
  /** Its full path. */
  path: string;
}

/** Every thread file of the store, sorted by name. `[]` when there is no `threads/`. */
export function listThreadFiles(storePath: string): ThreadFileEntry[] {
  const dir = historyStorePaths(storePath).threads;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(isThreadFileName)
    .sort()
    .map((name) => ({ name, path: resolve(dir, name) }));
}

/** The thread id stored inside an open thread file, or `undefined` when it has none. */
export function storedThreadId(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare(`SELECT value FROM thread_meta WHERE key = 'thread_id'`).get() as
      Record<string, unknown> | undefined;
    return row?.value != null ? String(row.value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The thread a file holds: read off its name when the name spells it, otherwise from inside the
 * file. `undefined` when neither answers.
 */
export function threadIdOfFile(entry: ThreadFileEntry): string | undefined {
  const direct = threadIdFromFileName(entry.name);
  if (direct !== undefined) return direct;
  let db: DatabaseSync | undefined;
  try {
    db = openConnection(entry.path, { readOnly: true });
    return storedThreadId(db);
  } catch {
    return undefined;
  } finally {
    closeQuietly(db);
  }
}

/**
 * Open the file of `threadId`, migrated and stamped with its id. `null` when the file does not exist
 * and `create` is false. THROWS when the file cannot be opened or migrated, or holds another
 * thread: the checkpoint saver treats that as a failed write, and every other caller is fail-soft
 * around it.
 */
export function openThreadDb(
  storePath: string,
  threadId: string,
  options: { create?: boolean } = {}
): DatabaseSync | null {
  const path = threadFilePath(storePath, threadId);
  if (!options.create && !existsSync(path)) return null;
  const db = openConnection(path);
  try {
    migrateFile(db, THREAD_SCHEMA_STEPS);
    const stored = storedThreadId(db);
    if (stored === undefined) {
      db.prepare(`INSERT OR IGNORE INTO thread_meta (key, value) VALUES ('thread_id', ?)`).run(
        threadId
      );
    } else if (stored !== threadId) {
      throw new Error(`History thread file ${path} holds another thread.`);
    }
    return db;
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

/** Make sure the file of `threadId` exists and is migrated. Throws like {@link openThreadDb}. */
export function ensureThreadFile(storePath: string, threadId: string): string {
  closeQuietly(openThreadDb(storePath, threadId, { create: true }) ?? undefined);
  return threadFilePath(storePath, threadId);
}

/**
 * Open the index, migrated. A missing index beside thread files is rebuilt from them first; a
 * missing index with no thread files is created only when `create` is set. `null` when there is
 * nothing to open. Throws when the index cannot be opened or migrated.
 */
export function openIndexDb(
  storePath: string,
  options: { create?: boolean } = {}
): DatabaseSync | null {
  const paths = historyStorePaths(storePath);
  if (!existsSync(paths.index)) {
    if (listThreadFiles(storePath).length > 0) {
      rebuildHistoryIndex(storePath);
    } else if (!options.create) {
      return null;
    }
  }
  const db = openConnection(paths.index);
  try {
    migrateFile(db, INDEX_SCHEMA_STEPS);
    return db;
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

/** What {@link rebuildHistoryIndex} put back. */
export interface IndexRebuildSummary {
  /** Files under `threads/` read: thread files and conversation record files alike. */
  threadFiles: number;
  /** Conversations restored into the index. */
  conversations: number;
  /** Turns restored into the index. */
  turns: number;
  /** Files that could not be read, and were left alone. */
  unreadable: number;
}

/**
 * Rebuild `index.db` from the thread files alone, replacing whatever index was there. Each
 * conversation keeps its integer id and run id. Should two files claim the same integer id (an
 * index that was lost and started again before this ran), the later one is given a new id and its
 * file is updated to match, so the files stay the record. Two records of the same run id are one
 * conversation: the first is kept.
 *
 * An index row whose record file is gone is not carried over, which is the rule that deleting one
 * file loses only what it held. The rebuilt index is written beside the old one and renamed over it,
 * so a failure part-way leaves the old index as it was. Throws on failure; the callers report it.
 */
export function rebuildHistoryIndex(storePath: string): IndexRebuildSummary {
  const paths = historyStorePaths(storePath);
  const staged = `${paths.index}.rebuild-${process.pid}`;
  rmSync(staged, { force: true });
  rmSync(`${staged}-journal`, { force: true });
  const summary: IndexRebuildSummary = {
    threadFiles: 0,
    conversations: 0,
    turns: 0,
    unreadable: 0,
  };
  const index = openConnection(staged);
  try {
    migrateFile(index, INDEX_SCHEMA_STEPS);
    const insertConversation = index.prepare(
      `INSERT INTO conversations
         (id, started_ts, project, command, model, thread_id, grants, run_id, origin, home_thread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const idTaken = index.prepare(`SELECT 1 AS hit FROM conversations WHERE id = ?`);
    const runIdTaken = index.prepare(`SELECT 1 AS hit FROM conversations WHERE run_id = ?`);
    const insertTurn = index.prepare(
      `INSERT INTO sessions
         (id, ts, project, command, model, prompt, response, tokens_input, tokens_output,
          cost_usd, tools, duration_ms, conversation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const turnTaken = index.prepare(`SELECT 1 AS hit FROM sessions WHERE id = ?`);
    const insertFts = index.prepare(
      `INSERT INTO sessions_fts (rowid, prompt, response, command, project) VALUES (?, ?, ?, ?, ?)`
    );
    const str = (v: unknown): string | null => (v != null ? String(v) : null);
    const num = (v: unknown): number | null => (v != null ? Number(v) : null);

    // Read every file's records first, then insert in the order the conversations started, so a
    // collision is always resolved in favour of the older conversation.
    interface Found {
      home: string;
      path: string;
      conversation: Record<string, unknown>;
      turns: Record<string, unknown>[];
    }
    const found: Found[] = [];
    for (const entry of listThreadFiles(storePath)) {
      let db: DatabaseSync | undefined;
      try {
        db = openConnection(entry.path);
        migrateFile(db, THREAD_SCHEMA_STEPS);
        const home = storedThreadId(db) ?? threadIdFromFileName(entry.name);
        if (home === undefined) {
          summary.unreadable += 1;
          continue;
        }
        summary.threadFiles += 1;
        const turnsOf = db.prepare(
          `SELECT * FROM turn_records WHERE conversation_id = ? ORDER BY id`
        );
        for (const conversation of db
          .prepare(`SELECT * FROM conversation_records ORDER BY id`)
          .all() as Record<string, unknown>[]) {
          found.push({
            home,
            path: entry.path,
            conversation,
            turns: turnsOf.all(Number(conversation.id)) as Record<string, unknown>[],
          });
        }
      } catch {
        summary.unreadable += 1;
      } finally {
        closeQuietly(db);
      }
    }
    found.sort(
      (a, b) =>
        String(a.conversation.started_ts).localeCompare(String(b.conversation.started_ts)) ||
        Number(a.conversation.id) - Number(b.conversation.id)
    );

    index.exec('BEGIN IMMEDIATE');
    try {
      for (const item of found) {
        const c = item.conversation;
        const runId = str(c.run_id);
        if (runId !== null && runIdTaken.get(runId)) continue;
        const wantedId = Number(c.id);
        const id = idTaken.get(wantedId) ? null : wantedId;
        const info = insertConversation.run(
          id,
          String(c.started_ts),
          str(c.project),
          str(c.command),
          str(c.model),
          str(c.thread_id),
          str(c.grants),
          runId,
          str(c.origin),
          item.home
        );
        const conversationId = Number(info.lastInsertRowid);
        if (conversationId !== wantedId) renumberInFile(item.path, wantedId, conversationId);
        summary.conversations += 1;
        for (const t of item.turns) {
          const turnId = Number(t.id);
          const turnInfo = insertTurn.run(
            turnTaken.get(turnId) ? null : turnId,
            String(t.ts),
            str(t.project),
            str(t.command),
            str(t.model),
            str(t.prompt),
            str(t.response),
            num(t.tokens_input),
            num(t.tokens_output),
            num(t.cost_usd),
            str(t.tools),
            num(t.duration_ms),
            conversationId
          );
          insertFts.run(
            Number(turnInfo.lastInsertRowid),
            str(t.prompt) ?? '',
            str(t.response) ?? '',
            str(t.command) ?? '',
            str(t.project) ?? ''
          );
          summary.turns += 1;
        }
      }
      index.exec('COMMIT');
    } catch (error) {
      index.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    closeQuietly(index);
    rmSync(staged, { force: true });
    throw error;
  }
  closeQuietly(index);
  rmSync(`${paths.index}-journal`, { force: true });
  renameSync(staged, paths.index);
  return summary;
}

/** Give a conversation record a new id inside its record file, turns included. */
function renumberInFile(path: string, from: number, to: number): void {
  const db = openConnection(path);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`UPDATE conversation_records SET id = ? WHERE id = ?`).run(to, from);
      db.prepare(`UPDATE turn_records SET conversation_id = ? WHERE conversation_id = ?`).run(
        to,
        from
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    closeQuietly(db);
  }
}

/**
 * The bytes the store occupies on disk: every file under it, the index and its journal and every
 * thread file included. Zero when nothing is there.
 */
export function storeDiskBytes(storePath: string): number {
  const walk = (path: string): number => {
    try {
      const stats = statSync(path);
      if (!stats.isDirectory()) return stats.size;
      return readdirSync(path).reduce((sum, name) => sum + walk(resolve(path, name)), 0);
    } catch {
      return 0;
    }
  };
  return walk(storePath);
}

/**
 * Delete one thread file and its journal. Returns whether the file is gone. On win32 a file another
 * connection holds open cannot be deleted; that is reported as `false`, never thrown.
 */
export function deleteThreadFile(path: string): boolean {
  try {
    rmSync(path, { force: true });
    for (const suffix of ['-journal', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    return !existsSync(path);
  } catch {
    return false;
  }
}
