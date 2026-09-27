/**
 * @packageDocumentation
 * GS2-121 — **where the history store lives, and what it is made of.** Every reader and writer of
 * the store resolves its location through {@link resolveHistoryDbPath} and then opens it through
 * `historyFiles.ts`, which is what makes the rules below hold everywhere at once.
 *
 * ## The layout
 *
 * ```
 * <store>/index.db             conversations, sessions, sessions_fts: small, searchable, a cache
 * <store>/threads/<name>.db    ONE LangGraph thread: its checkpoints and pending writes
 * <store>/threads/<name>.db    or ONE conversation's record file: its row and its turns
 * ```
 *
 * `<store>` is a directory. `threads/` is flat (Andrew, 2026-09-28): no grouping by date or
 * prefix. A file's name is derived from its id by {@link threadFileName}, and the real id is stored
 * inside the file, so the name never has to be decoded to be trusted.
 *
 * Both kinds of file have the same schema and are opened the same way; what differs is what is
 * written to them. A conversation's record file is keyed by an id of its own, never by a thread it
 * names, so checkpoint state and the durable transcript are never in the same file. That is what
 * lets a prune delete a thread's file whole and still keep the transcript.
 *
 * ## What `history.dbPath` means (a build decision, not ruled; recorded so it can be overruled)
 *
 * **It names the store, exactly as before, and the store at that path is now a directory.** The
 * default stays `~/.gsloth/history.db`. The one rule, for the default and for a configured path
 * alike: **a regular file at that path is a single-file store from an earlier release, and the first
 * open splits it into a directory at the same path.** `--db` on the history commands means the same.
 *
 * Why the same path rather than a new name such as `~/.gsloth/history/`:
 *
 * - One rule instead of two. A new default name would need a second rule for a configured path
 *   naming an old file (split it where? under what name?), and any second rule is a place for a
 *   user's store to be left behind.
 * - Nothing a user wrote stops working. A config that sets `history.dbPath`, a script passing
 *   `--db`, and every doc that names `~/.gsloth/history.db` still name their store.
 * - The cost is cosmetic: a directory whose name ends in `.db`. Opening it with `sqlite3` fails
 *   loudly rather than showing the wrong thing.
 *
 * The same-path rule means the old file has to move before the directory can take its place. The
 * split renames it to `<store>.pre-split` first, and that name is what an interrupted split resumes
 * from; see `splitLegacyStore` in `historyMigrations.ts`.
 *
 * ## The index is a cache; the thread files are the record
 *
 * - **Every conversation has a record file** (`conversations.home_thread` names it), minted with a
 *   fresh id when the conversation is opened. It carries the conversation's row and every turn
 *   recorded under it (`conversation_records`, `turn_records`), and nothing else.
 * - **File first, then the index row, in one commit.** A turn is written through the index
 *   connection with the record file ATTACHed, inside one transaction, so SQLite's multi-file commit
 *   (rollback journal, never WAL) lands both or neither. The two cannot drift. Checkpoints are
 *   written by the saver to the thread's own file and have no index row at all.
 * - **The index rebuilds from the files alone** (`rebuildHistoryIndex`, and `gth history rebuild`).
 *   A missing `index.db` beside a non-empty `threads/` is rebuilt on open. Ids are kept: a
 *   conversation's integer id and its run id come back as they were.
 * - **An index row naming a missing file is dropped.** Two cases, one per kind of file:
 *   - a conversation whose **thread file** is gone is answered as having no thread by every read,
 *     so it is listed and cannot be resumed, exactly as when its link was cut. That is done at read
 *     time and never as a sweep: a sweep could see a live session's row in the moment before its
 *     thread's first checkpoint creates the file;
 *   - a conversation whose **record file** is gone is dropped by the next rebuild, which keeps
 *     nothing a file does not carry.
 *
 *   Either way a deleted file loses only what it held.
 * - **A file with no index row is recoverable** by a rebuild when it is a record file, and an
 *   orphan when it is a thread file no conversation names, which retention reclaims.
 * - **A cut link is written to both.** When a checkpoint write fails, `clearConversationThread`
 *   clears the link in the index and in the record file, so a rebuild cannot make a truncated
 *   conversation resumable again.
 *
 * Search stays in the index: each turn's prompt and response are written there as well as to the
 * record file. The text is small; the gigabytes are checkpoint state.
 *
 * ## Migration
 *
 * Every file carries its own schema version (`PRAGMA user_version`) and is migrated when it is
 * opened, by the ordered steps in `historyMigrations.ts`. A later format change adds a step to the
 * list for the file kind it touches. No migration ever opens every thread at once: a thread file
 * is migrated when something opens that thread. The one store-wide step is the split of a
 * single-file store, which runs once, under a lock, resumably, and never reads the old file into
 * memory: every copy is an `INSERT … SELECT` inside SQLite, one thread per transaction.
 *
 * ## Retention, as file operations
 *
 * - `gth history prune` deletes the thread files of the conversations it selects, whole. Their
 *   transcripts stay, because they are in the conversations' record files, which prune never
 *   touches.
 * - The automatic pass deletes the files of threads no conversation names, past the grace window.
 * - A file that cannot be deleted (on Windows, one another process holds open) is emptied of its
 *   checkpoints and pending writes in one transaction and vacuumed instead, so its bytes come back
 *   either way. The same fallback covers a file holding both checkpoints and a conversation record,
 *   which this release never writes but a hand-built or damaged store could hold.
 * - **Both liveness guards survive.** An idle SQLite connection holds no lock, and POSIX lets a
 *   file be deleted while open, so "a live thread's file is open and locked" cannot be asked of the
 *   filesystem. The in-process write set (the saver's threads) and the cross-process grace window
 *   (the newest checkpoint's age) stay exactly as they were, applied per file.
 * - GS2-117's degrade-safe saver is unchanged: one saver routes each call to its thread's file,
 *   and its first failed write, in any file, stops durable writes for the whole saver.
 */
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getGlobalGslothDir, ensureGlobalGslothDir } from '#src/utils/globalConfigUtils.js';

/** The store's name inside `~/.gsloth`: a directory, despite the extension (see the note above). */
export const HISTORY_DB_FILENAME = 'history.db';

/** The index database's name inside the store directory. */
export const HISTORY_INDEX_FILENAME = 'index.db';

/** The flat directory of per-thread files inside the store directory. */
export const HISTORY_THREADS_DIRNAME = 'threads';

/** Where a single-file store is moved while it is being split; an interrupted split resumes here. */
export const PRE_SPLIT_SUFFIX = '.pre-split';

/** The lock file a split holds, beside the store. */
export const MIGRATION_LOCK_SUFFIX = '.migrating';

/** The paths that make up one store. */
export interface HistoryStorePaths {
  /** The store directory itself. */
  root: string;
  /** `<root>/index.db`. */
  index: string;
  /** `<root>/threads`. */
  threads: string;
  /** `<root>.pre-split`: a single-file store part-way through its split. */
  preSplit: string;
  /** `<root>.migrating`: the split's lock. */
  lock: string;
}

/** Every path of the store at `storePath`. */
export function historyStorePaths(storePath: string): HistoryStorePaths {
  return {
    root: storePath,
    index: resolve(storePath, HISTORY_INDEX_FILENAME),
    threads: resolve(storePath, HISTORY_THREADS_DIRNAME),
    preSplit: `${storePath}${PRE_SPLIT_SUFFIX}`,
    lock: `${storePath}${MIGRATION_LOCK_SUFFIX}`,
  };
}

/**
 * A thread id that can be a file name as it stands: lowercase hex digits and dashes, which covers
 * every id this code mints (`randomUUID()`), cannot traverse, cannot collide with a Windows device
 * name, and cannot collide with another id on a case-insensitive filesystem.
 */
const PLAIN_THREAD_ID = /^[0-9a-f][0-9a-f-]{0,79}$/;

/** The prefix of a file named by the hash of its thread id rather than by the id itself. */
const HASHED_PREFIX = 'h-';

/**
 * The file name holding `threadId`. A plain id ({@link PLAIN_THREAD_ID}) is used as it stands;
 * anything else is named by its SHA-256, and the id is read back from inside the file.
 */
export function threadFileName(threadId: string): string {
  if (PLAIN_THREAD_ID.test(threadId)) return `${threadId}.db`;
  return `${HASHED_PREFIX}${createHash('sha256').update(threadId, 'utf8').digest('hex')}.db`;
}

/**
 * The thread id a file name spells, when it spells one directly; `undefined` for a hashed name
 * (whose id is only inside the file) and for anything that is not a thread file.
 */
export function threadIdFromFileName(name: string): string | undefined {
  if (!name.endsWith('.db')) return undefined;
  const stem = name.slice(0, -3);
  return PLAIN_THREAD_ID.test(stem) ? stem : undefined;
}

/** Whether `name` is a thread file's name, direct or hashed. */
export function isThreadFileName(name: string): boolean {
  if (!name.endsWith('.db')) return false;
  const stem = name.slice(0, -3);
  return PLAIN_THREAD_ID.test(stem) || /^h-[0-9a-f]{64}$/.test(stem);
}

/** The path of the file holding `threadId` in the store at `storePath`. */
export function threadFilePath(storePath: string, threadId: string): string {
  return resolve(historyStorePaths(storePath).threads, threadFileName(threadId));
}

/**
 * The history store's location. Honors an explicit `dbPath` (from `history.dbPath` or a `--db`
 * flag); otherwise the global `~/.gsloth/history.db`. When `dbPath` is omitted and `ensureDir` is
 * true, `~/.gsloth` is created so the recorder can write; the store directory itself is created by
 * the opener, never here, and never with its parents (a configured path under a directory that does
 * not exist is refused rather than conjured).
 *
 * Every history reader and writer resolves through this one function; the precedence a command
 * applies before calling it is `--db`, then `history.dbPath`, then the default.
 */
export function resolveHistoryDbPath(dbPath?: string, ensureDir = false): string {
  if (dbPath && dbPath.trim().length > 0) return dbPath;
  const dir = ensureDir ? ensureGlobalGslothDir() : getGlobalGslothDir();
  return resolve(dir, HISTORY_DB_FILENAME);
}
