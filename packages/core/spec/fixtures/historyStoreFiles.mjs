/**
 * GS2-121 — read a history store's files straight off the disk, for specs that assert on what a
 * run wrote. The store is a directory: `index.db` holds conversations, sessions and the search
 * index, and `threads/<name>.db` holds one thread's checkpoints and pending writes each (see
 * `historyLayout.ts`). These helpers find a thread's file by the id stored INSIDE it, not by
 * re-deriving the file name, so a spec never shares a naming rule with the code it checks.
 *
 * Plain `node:sqlite` and `node:fs`, no imports from the package, and read-only except where a
 * helper says otherwise.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The store's index file. */
export function indexPath(storePath) {
  return join(storePath, 'index.db');
}

/** Every thread file in the store as `{ threadId, path }`, sorted by thread id. */
export function threadFiles(storePath) {
  const dir = join(storePath, 'threads');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    const path = join(dir, name);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const row = db.prepare(`SELECT value FROM thread_meta WHERE key = 'thread_id'`).get();
      if (row) out.push({ threadId: String(row.value), path });
    } finally {
      db.close();
    }
  }
  return out.sort((a, b) => a.threadId.localeCompare(b.threadId));
}

/** The path of one thread's file, or `undefined` when the store has none for it. */
export function threadFilePathOf(storePath, threadId) {
  return threadFiles(storePath).find((f) => f.threadId === threadId)?.path;
}

/**
 * Rows in `table`: `conversations` and `sessions` are counted in the index; `checkpoints` and
 * `checkpoint_writes` are summed over every thread file, or read from one thread's file when
 * `threadId` is given.
 */
export function countRows(storePath, table, threadId) {
  if (table === 'conversations' || table === 'sessions') {
    if (!existsSync(indexPath(storePath))) return 0;
    const db = new DatabaseSync(indexPath(storePath), { readOnly: true });
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    } finally {
      db.close();
    }
  }
  let total = 0;
  for (const file of threadFiles(storePath)) {
    if (threadId !== undefined && file.threadId !== threadId) continue;
    const db = new DatabaseSync(file.path, { readOnly: true });
    try {
      total += Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    } finally {
      db.close();
    }
  }
  return total;
}

/** The ids of every thread that holds at least one checkpoint, sorted. */
export function checkpointThreadIds(storePath) {
  return threadFiles(storePath)
    .filter((file) => countRows(storePath, 'checkpoints', file.threadId) > 0)
    .map((file) => file.threadId);
}

/**
 * Open one thread's file for writing fixtures or reading rows. The caller closes it. Throws when
 * the store has no file for that thread.
 */
export function openThreadFile(storePath, threadId) {
  const path = threadFilePathOf(storePath, threadId);
  if (path === undefined) throw new Error(`No thread file for ${threadId} in ${storePath}`);
  return new DatabaseSync(path);
}

/** Open the store's index for writing fixtures or reading rows. The caller closes it. */
export function openIndex(storePath) {
  return new DatabaseSync(indexPath(storePath));
}

/**
 * Make every durable write of a checkpoint saver fail with a real SQLite error, from now on: the
 * saver holds one connection per thread file, so the connections it holds are made read-only and
 * so is every one it opens later. White-box by necessity — it reaches the saver's private
 * `connections` map and `connection` method.
 */
export function breakSaverWrites(saver) {
  for (const db of saver.connections.values()) db.exec('PRAGMA query_only = 1');
  const open = saver.connection.bind(saver);
  saver.connection = (threadId, create) => {
    const db = open(threadId, create);
    db?.exec('PRAGMA query_only = 1');
    return db;
  };
}

/** The saver's held connection for one thread, or `undefined`. White-box, like the above. */
export function heldConnection(saver, threadId) {
  return saver.connections.get(threadId);
}

/**
 * Bytes the store occupies: every regular file under it, summed. Walked here rather than asked of
 * the product, so a spec measuring the product's reclaim does not use the product's own ruler.
 */
export function storeSizeOnDisk(storePath) {
  let total = 0;
  const walk = (path) => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
    } else if (stats.isFile()) {
      total += stats.size;
    }
  };
  if (existsSync(storePath)) walk(storePath);
  return total;
}
