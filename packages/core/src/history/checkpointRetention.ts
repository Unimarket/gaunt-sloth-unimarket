/**
 * @packageDocumentation
 * GS2-107 — **the retention policy for the stored checkpoint state, and the readout that makes its
 * size visible.** GS2-121 — applied to a store of one file per thread (`historyLayout.ts`), so every
 * pass here is a file operation.
 *
 * A checkpoint is not a history row. A `sessions` row is a prompt and a response; a checkpoint is
 * the state the agent was working with — tool results verbatim, file contents that were read,
 * command output, whatever an MCP server returned. `history.enabled` is on by default, so every
 * interactive session writes full graph state per super-step, and without this module nothing
 * would ever reclaim a byte.
 *
 * ## The policy, and why it is split in two
 *
 * **Automatic reclamation removes only what can never be resumed. Anything that would cost a user a
 * resume is available only as an explicit command they type.** That follows the ruling GS2-20 was
 * built to: resume sheds nothing, and shedding is the user's own act. An age-based sweep that
 * silently made an old conversation unresumable would remove, without being asked, the one
 * capability the durable checkpointer exists to provide.
 *
 * So:
 *
 * - {@link reclaimUnresumableThreads} is automatic and cannot cost a resume, because it only
 *   takes threads **no conversation row names** — see the predicate below.
 * - {@link selectPrunableConversations} + {@link removeThreadState} is `gth history prune`: it
 *   removes state a user *could* still have resumed, so it is never automatic, never has a silent
 *   default bound, and says what it will remove before it removes it.
 * - {@link findWriteOnlyThreads} rides on `gth history prune` and on nothing else. It is the only
 *   pass that can reach a thread with pending writes and no checkpoint at all — rows no reader in
 *   this codebase can return, which is why they need a pass of their own.
 *
 * ## What "removing a thread's state" is, file by file
 *
 * {@link removeThreadState} is the one implementation, and it **deletes the thread's file whole**. A
 * conversation's transcript is not in that file: it is in the conversation's own record file (see
 * `historyLayout.ts`), which no pass here touches, so a pruned conversation keeps its transcript and
 * the index can still be rebuilt with it in.
 *
 * The one exception is a file that cannot be deleted, or that holds a conversation record as well
 * as checkpoints (this release never writes one; a hand-built or damaged store could hold one). That
 * file keeps its records, loses every checkpoint and pending write in one transaction, and is
 * vacuumed. The bytes come back either way.
 *
 * ## The predicate: one class, not two
 *
 * A resume travels exactly one link — `gth history list` prints a conversation id,
 * `conversations.thread_id` turns that id into a thread, and the thread is what the resume looks up.
 * So a thread that **no conversation row names** cannot be reached by any id a person could type:
 * it is unaddressable, and removing its state removes no capability anyone had.
 *
 * That single predicate covers both classes of unresumable state:
 *
 * - a thread with **no conversation row at all** — a `/clear` mints a fresh thread that nothing ever
 *   names ([[EXT-109]]), and an abandoned boot or a test can leave one too;
 * - a conversation whose **`thread_id` is NULL** — written by `clearConversationThread` when a
 *   checkpoint write fails. NULLing the column *destroys the link*, so the thread it used to name is
 *   thereafter unaddressable by exactly the definition above.
 *
 * ## The one class that predicate cannot see: a thread with writes and no checkpoint
 *
 * The predicate asks about threads that *have* a checkpoint. A thread file with rows only in
 * `checkpoint_writes` answers neither, and it is not a hypothetical shape: `put` is fail-soft by
 * contract while `putWrites` is a separate call that goes on landing, so a thread whose first `put`
 * was dropped keeps its pending writes with no checkpoint to attach them to, for good. Nothing can
 * read those rows, because pending writes are only ever handed back attached to a checkpoint tuple.
 * {@link findWriteOnlyThreads} is the second predicate. It carries no age (there is no checkpoint to
 * read one from), so the automatic pass never takes it — only `gth history prune`, where a person
 * typed a bound and was shown what goes.
 *
 * ## Whole threads, never a prefix
 *
 * Pruning the middle of a thread is forbidden here even though it was **measured not to break this
 * graph**: `channelsFromCheckpoint` walks ancestors only for a `DeltaChannel` absent from
 * `channel_values`, and this state schema has none (`messages` is a `BinaryOperatorAggregate` and
 * every checkpoint carries the whole array). A prefix policy is nevertheless a wider decision than
 * retention makes, and it would become wrong the moment a channel moves behind a reducer. Whole
 * threads only. (Growth inside one thread is GS2-122.)
 *
 * ## Two guards, and which one covers which case
 *
 * `/clear` rotates a **live** session onto a thread no conversation row names, and it stays there
 * for the rest of the session. So "unaddressable" does not imply "finished": a thread being written
 * right now can satisfy the predicate, and removing it is silent amnesia rather than a lost resume.
 *
 * - **In this process, the write set.** `GthSqliteSaver` remembers every `thread_id` it has written
 *   and excludes that set from every pass it runs. It is the only place that knows: the runner
 *   rotates threads without notifying the checkpointer.
 * - **Across processes, {@link RECLAIM_GRACE_MS}.** Another process cannot be asked whether it is
 *   still there, so nothing is reclaimed until its newest checkpoint is older than the window. A
 *   thread whose age cannot be established is left alone.
 *
 * One file per thread does NOT replace the second guard with "a live thread's file is open and
 * locked". An idle SQLite connection holds no lock at all — a lock exists only for the length of a
 * statement or a transaction — and POSIX deletes a file another process has open without
 * complaint. So nothing on the filesystem tells a live thread from a finished one, and both guards
 * stay exactly as they were. The residual is unchanged too: a session in another process idle for
 * longer than the window.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import {
  deleteThreadFile,
  listThreadFiles,
  openIndexDb,
  prepareHistoryStore,
  storeDiskBytes,
  threadIdOfFile,
  type ThreadFileEntry,
} from '#src/history/historyFiles.js';
import { historyStorePaths, threadFilePath } from '#src/history/historyLayout.js';
import {
  THREAD_SCHEMA_STEPS,
  closeQuietly,
  migrateFile,
  openConnection,
} from '#src/history/historyMigrations.js';

/**
 * How stale a thread's newest checkpoint must be before automatic reclamation will touch it.
 *
 * Not a tidy-up margin: after a `/clear` a live session writes every remaining checkpoint under a
 * thread no conversation row names, and another process cannot be asked whether it is still there.
 * A day is far longer than the gap between two super-steps of a session anyone is still using,
 * while still reclaiming the state within a day of the session ending.
 */
export const RECLAIM_GRACE_MS = 24 * 60 * 60 * 1000;

/** How many threads the readout names individually. */
export const DEFAULT_TOP_THREADS = 5;

/** One thread's footprint in the store. */
export interface ThreadUsage {
  threadId: string;
  /** The conversation that names this thread, when one does — absent means unaddressable. */
  conversationId?: number;
  command?: string;
  checkpointCount: number;
  /** Bytes of checkpoint / metadata / pending-write blobs stored under the thread. */
  bytes: number;
  /** The `ts` of the newest checkpoint, when it could be read. */
  newestTs?: string;
}

/** What the store's checkpoint state holds, for the readout. */
export interface CheckpointStoreStats {
  /** The store directory. */
  dbPath: string;
  /**
   * Bytes the whole store occupies on disk — the index (transcripts and the search index) and every
   * thread file — so it is reported beside {@link checkpointBytes} rather than instead of it. Zero
   * when nothing is there.
   */
  fileBytes: number;
  /** Bytes of checkpoint, metadata and pending-write blobs — the checkpoint state's own share. */
  checkpointBytes: number;
  checkpointCount: number;
  writeCount: number;
  threadCount: number;
  /** The biggest threads by stored bytes, largest first. */
  largestThreads: ThreadUsage[];
  /** Threads no conversation row names, and what they cost — what reclamation will take. */
  unresumableThreadCount: number;
  unresumableBytes: number;
  /**
   * Threads holding pending writes and no checkpoint, and what they cost. Counted inside
   * {@link checkpointBytes}; reported apart because only `gth history prune` removes them.
   */
  writeOnlyThreadCount: number;
  writeOnlyBytes: number;
}

/** What one {@link reclaimUnresumableThreads} / {@link removeThreadState} pass removed. */
export interface ReclaimSummary {
  threadCount: number;
  checkpointCount: number;
  writeCount: number;
  bytes: number;
}

/** A conversation `gth history prune` would remove the stored state of. */
export interface PrunableConversation {
  conversationId: number;
  threadId: string;
  command?: string;
  /** Last recorded activity: the newest turn's timestamp, or the conversation's start. */
  lastActivityTs: string;
  turnCount: number;
  checkpointCount: number;
  bytes: number;
  /**
   * True when the last recorded turn is newer than {@link RECLAIM_GRACE_MS} — so this conversation
   * may be **open in another window right now**, and pruning it would take a live session's memory
   * rather than an old one's.
   *
   * A flag and not an exclusion, deliberately. `gth history prune` is given an explicit bound by the
   * person typing it, and silently keeping back rows inside that bound would make the bound a lie;
   * liveness across processes is also not knowable from here, so a refusal would be a guess wearing
   * a guarantee. The automatic pass can be conservative because nobody asked for it. This one says
   * what it is about to do and lets the person answer.
   */
  recentlyActive: boolean;
}

/** Bounds for {@link selectPrunableConversations}. At least one is required by the command. */
export interface PruneBounds {
  /** Prune conversations whose last activity is older than this many days. */
  olderThanDays?: number;
  /**
   * Keep the N most recently active resumable conversations **whole** and prune the rest.
   *
   * Deliberately NOT "keep the last N super-steps of each thread": that is the prefix policy this
   * module forbids, and a flag whose name suggested it would be a documentation hazard.
   */
  keepLast?: number;
  /** Injectable clock for the age bound. */
  now?: number;
}

const EMPTY_RECLAIM: ReclaimSummary = {
  threadCount: 0,
  checkpointCount: 0,
  writeCount: 0,
  bytes: 0,
};

/**
 * Every thread a conversation row names — the half of the link the predicate reads. Named as one
 * constant so a spec can hold the query this runs.
 */
export const NAMED_THREADS_SQL = `SELECT DISTINCT thread_id FROM conversations
    WHERE thread_id IS NOT NULL AND thread_id <> ''`;

/** One thread file's contents, counted. */
interface ThreadFacts {
  threadId: string;
  path: string;
  checkpointCount: number;
  writeCount: number;
  /** Checkpoint, metadata and pending-write blob bytes. */
  bytes: number;
  /** Whether the file holds a conversation record, which a removal must keep. */
  hasRecords: boolean;
  /** The `ts` of the newest checkpoint, when asked for and readable. */
  newestTs?: string;
}

/**
 * The `ts` a checkpoint recorded for itself, or `undefined` when it cannot be read.
 *
 * The saver stores the serializer's own bytes; the shipped `JsonPlusSerializer` writes plain JSON
 * with a top-level ISO `ts`, which every checkpoint LangGraph builds carries. Anything else — a row
 * from another serializer, a truncated blob — yields `undefined`, and the callers treat that as
 * "age unknown", which is the safe direction: an unknown age is never old enough to reclaim.
 */
function checkpointTs(blob: unknown): string | undefined {
  if (!(blob instanceof Uint8Array)) return undefined;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(blob)) as Record<string, unknown>;
    return typeof parsed.ts === 'string' ? parsed.ts : undefined;
  } catch {
    return undefined;
  }
}

/** Count one open thread file. */
function countThreadDb(
  db: DatabaseSync,
  threadId: string,
  path: string,
  withAge: boolean
): ThreadFacts {
  const checkpoints = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(checkpoint) + LENGTH(metadata)), 0) AS bytes
         FROM checkpoints`
    )
    .get() as Record<string, unknown>;
  const writes = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(value)), 0) AS bytes FROM checkpoint_writes`
    )
    .get() as Record<string, unknown>;
  const records = db.prepare(`SELECT COUNT(*) AS n FROM conversation_records`).get() as Record<
    string,
    unknown
  >;
  const facts: ThreadFacts = {
    threadId,
    path,
    checkpointCount: Number(checkpoints.n ?? 0),
    writeCount: Number(writes.n ?? 0),
    bytes: Number(checkpoints.bytes ?? 0) + Number(writes.bytes ?? 0),
    hasRecords: Number(records.n ?? 0) > 0,
  };
  if (withAge && facts.checkpointCount > 0) {
    // Only the NEWEST checkpoint is read — one row, not a scan of the thread's history — because a
    // thread is live if anything in it is recent. Checkpoint ids are uuid6 and sort in creation
    // order, the same ordering the saver uses for "the latest checkpoint".
    const row = db
      .prepare(`SELECT checkpoint FROM checkpoints ORDER BY checkpoint_id DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    facts.newestTs = checkpointTs(row?.checkpoint);
  }
  return facts;
}

/**
 * Count one thread file, opened read-only. `undefined` when it cannot be read, or holds no known
 * thread, or has not been migrated to a schema this release can read.
 */
function readThreadFacts(entry: ThreadFileEntry, withAge: boolean): ThreadFacts | undefined {
  const threadId = threadIdOfFile(entry);
  if (threadId === undefined) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = openConnection(entry.path, { readOnly: true });
    return countThreadDb(db, threadId, entry.path, withAge);
  } catch {
    return undefined;
  } finally {
    closeQuietly(db);
  }
}

/** Every thread file of the store, counted. Files that cannot be read are left out. */
function allThreadFacts(storePath: string, withAge: boolean): ThreadFacts[] {
  const out: ThreadFacts[] = [];
  for (const entry of listThreadFiles(storePath)) {
    const facts = readThreadFacts(entry, withAge);
    if (facts) out.push(facts);
  }
  return out;
}

/** The facts of the named threads that have a file. */
function factsOf(storePath: string, threadIds: readonly string[]): Map<string, ThreadFacts> {
  const out = new Map<string, ThreadFacts>();
  for (const threadId of new Set(threadIds)) {
    const path = threadFilePath(storePath, threadId);
    if (!existsSync(path)) continue;
    const name = path.slice(historyStorePaths(storePath).threads.length + 1);
    const facts = readThreadFacts({ name, path }, false);
    if (facts && facts.threadId === threadId) out.set(threadId, facts);
  }
  return out;
}

/**
 * Run `read` over the index, or answer `fallback` when there is none. Retention never acts without
 * the index: without the conversation rows every thread would look unaddressable and a pass would
 * take the whole store.
 */
function withIndex<T>(storePath: string, fallback: T, read: (index: DatabaseSync) => T): T {
  let index: DatabaseSync | null = null;
  try {
    index = openIndexDb(storePath, { create: false });
    if (!index) return fallback;
    return read(index);
  } catch {
    return fallback;
  } finally {
    closeQuietly(index ?? undefined);
  }
}

/** The set {@link NAMED_THREADS_SQL} answers. */
function namedThreads(index: DatabaseSync): Set<string> {
  return new Set(
    (index.prepare(NAMED_THREADS_SQL).all() as Record<string, unknown>[]).map((r) =>
      String(r.thread_id)
    )
  );
}

/**
 * Every thread with checkpoints that **no conversation row names** — see the module note for why
 * that one predicate covers both unresumable classes.
 *
 * `includeWithinGrace: true` answers "what is unaddressable", which is what the readout reports;
 * the default answers "what may be removed now", which additionally requires the thread's newest
 * checkpoint to be older than {@link RECLAIM_GRACE_MS}. Never throws; `[]` when the store has no
 * index to read the conversation rows from.
 */
export function findUnaddressableThreads(
  storePath: string,
  options: {
    now?: number;
    graceMs?: number;
    includeWithinGrace?: boolean;
    excludeThreadIds?: readonly string[];
  } = {}
): string[] {
  const graceMs = options.graceMs ?? RECLAIM_GRACE_MS;
  const now = options.now ?? Date.now();
  const excluded = new Set(options.excludeThreadIds ?? []);
  return withIndex(storePath, [] as string[], (index) => {
    const named = namedThreads(index);
    const threads: string[] = [];
    for (const facts of allThreadFacts(storePath, !options.includeWithinGrace)) {
      if (named.has(facts.threadId) || excluded.has(facts.threadId)) continue;
      if (facts.checkpointCount === 0) continue;
      if (!options.includeWithinGrace) {
        if (facts.newestTs === undefined) continue; // age unknown ⇒ never old enough
        const age = now - Date.parse(facts.newestTs);
        if (!Number.isFinite(age) || age < graceMs) continue;
      }
      threads.push(facts.threadId);
    }
    return threads;
  });
}

/**
 * GS2-108 — the second predicate: every thread file holding pending writes and no checkpoint — see
 * the module note for why the conversation-link predicate cannot see one. Never throws.
 *
 * The residual, stated rather than engineered around: another process can hold a thread that is
 * momentarily write-only, between the checkpoint write for a super-step and the writes of its
 * tasks. Taking those rows costs that conversation a re-run of one super-step's tasks on a later
 * resume. `excludeThreadIds` is here so an in-process caller could supply protection; no production
 * caller does, because the only ones are the readout and `gth history prune`, which write no
 * checkpoints of their own.
 */
export function findWriteOnlyThreads(
  storePath: string,
  options: { excludeThreadIds?: readonly string[] } = {}
): string[] {
  const excluded = new Set(options.excludeThreadIds ?? []);
  try {
    return allThreadFacts(storePath, false)
      .filter((f) => f.checkpointCount === 0 && f.writeCount > 0 && !excluded.has(f.threadId))
      .map((f) => f.threadId);
  } catch {
    return [];
  }
}

/**
 * Remove every checkpoint and pending write of the named threads, and report what went. Each
 * thread's file is deleted whole; a file that also holds a conversation record is stripped of its
 * checkpoint state inside one transaction (both tables or neither) and vacuumed instead. See the
 * module note.
 *
 * `beforeRemove` is called with each thread id before its file is touched, so a caller holding a
 * connection to it can close it first: on win32 an open file cannot be deleted. A file that still
 * cannot be deleted is stripped instead, so its bytes are released either way.
 *
 * Never throws. A thread whose removal failed is not counted.
 */
export function removeThreadState(
  storePath: string,
  threadIds: readonly string[],
  options: { beforeRemove?: (threadId: string) => void } = {}
): ReclaimSummary {
  const summary: ReclaimSummary = { ...EMPTY_RECLAIM };
  for (const threadId of new Set(threadIds)) {
    if (threadId.length === 0) continue;
    const path = threadFilePath(storePath, threadId);
    if (!existsSync(path)) continue;
    try {
      options.beforeRemove?.(threadId);
    } catch {
      /* the hook only releases the caller's own handle; its failure must not stop the pass */
    }
    let db: DatabaseSync | undefined;
    try {
      db = openConnection(path);
      migrateFile(db, THREAD_SCHEMA_STEPS);
      const facts = countThreadDb(db, threadId, path, false);
      if (facts.checkpointCount === 0 && facts.writeCount === 0) continue;
      let removed = false;
      if (!facts.hasRecords) {
        closeQuietly(db);
        db = undefined;
        removed = deleteThreadFile(path);
        if (!removed) db = openConnection(path);
      }
      if (!removed && db) {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec('DELETE FROM checkpoints');
          db.exec('DELETE FROM checkpoint_writes');
          db.exec('COMMIT');
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* already unwound */
          }
          throw error;
        }
        try {
          db.exec('VACUUM');
        } catch {
          /* the rows are gone; a file that could not be compacted is reused by the next write */
        }
      }
      summary.threadCount += 1;
      summary.checkpointCount += facts.checkpointCount;
      summary.writeCount += facts.writeCount;
      summary.bytes += facts.bytes;
    } catch {
      /* nothing is reported for a thread whose removal did not happen */
    } finally {
      closeQuietly(db);
    }
  }
  return summary;
}

/**
 * The automatic half of the policy: remove the state of every thread no conversation row names and
 * whose newest checkpoint is past the grace window. Never throws, and never touches a thread a
 * resume could reach.
 */
export function reclaimUnresumableThreads(
  storePath: string,
  options: {
    now?: number;
    graceMs?: number;
    excludeThreadIds?: readonly string[];
    beforeRemove?: (threadId: string) => void;
  } = {}
): ReclaimSummary {
  const threads = findUnaddressableThreads(storePath, options);
  if (threads.length === 0) return { ...EMPTY_RECLAIM };
  return removeThreadState(storePath, threads, { beforeRemove: options.beforeRemove });
}

/**
 * The conversations `gth history prune` would remove the stored state of, newest activity first.
 *
 * A conversation qualifies when it still names a thread that has checkpoints (there is something to
 * remove) and it satisfies **every** bound given. `olderThanDays` and `keepLast` therefore compose
 * as a conjunction: with both, a conversation is pruned only when it is older than the age AND
 * outside the newest N. Passing neither selects nothing — the command requires an explicit bound,
 * so that there is no silent default for an operation that can cost a resume.
 *
 * **Neither of the automatic pass's two guards applies here, and that is the design.** The bounds
 * the person typed are the whole selection; what this does instead is *say so* —
 * {@link PrunableConversation.recentlyActive} marks every candidate whose last turn is inside
 * {@link RECLAIM_GRACE_MS}, the plan prints that marker, and the command asks before removing
 * anything.
 */
export function selectPrunableConversations(
  storePath: string,
  bounds: PruneBounds
): PrunableConversation[] {
  if (bounds.olderThanDays === undefined && bounds.keepLast === undefined) return [];
  return withIndex(storePath, [] as PrunableConversation[], (index) => {
    const rows = index
      .prepare(
        `SELECT c.id AS id, c.thread_id AS thread_id, c.command AS command,
                c.started_ts AS started_ts,
                COUNT(s.id) AS turn_count,
                MAX(s.ts) AS last_ts
           FROM conversations c
           LEFT JOIN sessions s ON s.conversation_id = c.id
          WHERE c.thread_id IS NOT NULL AND c.thread_id <> ''
          GROUP BY c.id`
      )
      .all() as Record<string, unknown>[];
    const candidates = rows.map((r) => ({
      conversationId: Number(r.id),
      threadId: String(r.thread_id),
      command: r.command != null ? String(r.command) : undefined,
      lastActivityTs: r.last_ts != null ? String(r.last_ts) : String(r.started_ts),
      turnCount: Number(r.turn_count ?? 0),
    }));
    // Newest activity first, so `keepLast` counts from the most recent conversation.
    candidates.sort((a, b) => b.lastActivityTs.localeCompare(a.lastActivityTs));

    const now = bounds.now ?? Date.now();
    const cutoff =
      bounds.olderThanDays === undefined
        ? undefined
        : now - bounds.olderThanDays * 24 * 60 * 60 * 1000;
    const selected = candidates.filter((candidate, index) => {
      if (bounds.keepLast !== undefined && index < bounds.keepLast) return false;
      if (cutoff !== undefined) {
        const at = Date.parse(candidate.lastActivityTs);
        // An unparseable timestamp is an unknown age, and an unknown age never satisfies an age
        // bound — the same safe direction the grace window takes.
        if (!Number.isFinite(at) || at >= cutoff) return false;
      }
      return true;
    });
    if (selected.length === 0) return [];

    const perThread = factsOf(
      storePath,
      selected.map((c) => c.threadId)
    );
    // Only a conversation with something actually stored is offered: naming one whose thread holds
    // no checkpoints would report a removal that reclaims nothing.
    return selected
      .map((c) => {
        const counted = perThread.get(c.threadId);
        const at = Date.parse(c.lastActivityTs);
        return {
          ...c,
          checkpointCount: counted?.checkpointCount ?? 0,
          bytes: counted?.bytes ?? 0,
          // Same window the automatic pass uses, read off the turn row rather than the checkpoint
          // blob: the turn is written after the checkpoints of that turn, so it is the later of the
          // two and a conservative answer to "was something happening here recently".
          recentlyActive: Number.isFinite(at) && now - at < RECLAIM_GRACE_MS,
        };
      })
      .filter((c) => c.checkpointCount > 0);
  });
}

/**
 * The readout: what the store's checkpoint state holds, and what of it is unaddressable.
 *
 * `fileBytes` and `checkpointBytes` are reported separately on purpose — the store also holds the
 * session transcripts (twice: in the index, and in each record file) and the search index, so one
 * number labelled "checkpoints" that is really the whole store would be a false statement on the
 * very screen this exists to make honest.
 */
export function collectCheckpointStoreStats(
  storePath: string,
  topN = DEFAULT_TOP_THREADS
): CheckpointStoreStats {
  const fileBytes = storeDiskBytes(storePath);
  const empty: CheckpointStoreStats = {
    dbPath: storePath,
    fileBytes,
    checkpointBytes: 0,
    checkpointCount: 0,
    writeCount: 0,
    threadCount: 0,
    largestThreads: [],
    unresumableThreadCount: 0,
    unresumableBytes: 0,
    writeOnlyThreadCount: 0,
    writeOnlyBytes: 0,
  };
  try {
    const all = allThreadFacts(storePath, false);
    // Which conversation names each thread, so the readout can say which of the biggest threads is
    // a conversation someone could resume and which is dead weight. Without an index, none is named.
    const owners = withIndex(
      storePath,
      new Map<string, { id: number; command?: string }>(),
      (index) => {
        const map = new Map<string, { id: number; command?: string }>();
        for (const r of index
          .prepare(
            `SELECT thread_id, id, command FROM conversations
              WHERE thread_id IS NOT NULL AND thread_id <> '' ORDER BY id`
          )
          .all() as Record<string, unknown>[]) {
          const threadId = String(r.thread_id);
          if (!map.has(threadId)) {
            map.set(threadId, {
              id: Number(r.id),
              command: r.command != null ? String(r.command) : undefined,
            });
          }
        }
        return map;
      }
    );
    const withCheckpoints = all.filter((f) => f.checkpointCount > 0);
    const largest = [...withCheckpoints]
      .sort((a, b) => b.bytes - a.bytes || a.threadId.localeCompare(b.threadId))
      .slice(0, Math.max(0, topN));
    const unaddressable = new Set(
      findUnaddressableThreads(storePath, { includeWithinGrace: true })
    );
    const writeOnly = all.filter((f) => f.checkpointCount === 0 && f.writeCount > 0);
    return {
      dbPath: storePath,
      fileBytes,
      checkpointBytes: all.reduce((sum, f) => sum + f.bytes, 0),
      checkpointCount: all.reduce((sum, f) => sum + f.checkpointCount, 0),
      writeCount: all.reduce((sum, f) => sum + f.writeCount, 0),
      threadCount: withCheckpoints.length,
      largestThreads: largest.map((f) => {
        const owner = owners.get(f.threadId);
        return {
          threadId: f.threadId,
          conversationId: owner?.id,
          command: owner?.command,
          checkpointCount: f.checkpointCount,
          bytes: f.bytes,
        };
      }),
      unresumableThreadCount: unaddressable.size,
      unresumableBytes: all
        .filter((f) => unaddressable.has(f.threadId))
        .reduce((sum, f) => sum + f.bytes, 0),
      writeOnlyThreadCount: writeOnly.length,
      writeOnlyBytes: writeOnly.reduce((sum, f) => sum + f.bytes, 0),
    };
  } catch {
    return empty;
  }
}

/**
 * The maintenance commands' handle on one store, or `null` when there is nothing there. Fail-soft
 * in the same shape as `openHistoryStore` / `openCheckpointSaver`, and it never CREATES a store:
 * `gth history prune` on a machine with no history should say there is none, not leave an empty
 * store behind. It does split a single-file store, like every other open.
 */
export class CheckpointMaintenance {
  private constructor(private readonly storePath: string) {}

  static open(storePath: string): CheckpointMaintenance | null {
    if (prepareHistoryStore(storePath, { create: false }) !== 'ready') return null;
    const paths = historyStorePaths(storePath);
    if (!existsSync(paths.index) && listThreadFiles(storePath).length === 0) return null;
    return new CheckpointMaintenance(storePath);
  }

  stats(topN = DEFAULT_TOP_THREADS): CheckpointStoreStats {
    return collectCheckpointStoreStats(this.storePath, topN);
  }

  prunable(bounds: PruneBounds): PrunableConversation[] {
    return selectPrunableConversations(this.storePath, bounds);
  }

  unaddressable(options: { now?: number; graceMs?: number } = {}): string[] {
    return findUnaddressableThreads(this.storePath, options);
  }

  /** GS2-108 — threads holding pending writes and no checkpoint, which only a prune reclaims. */
  writeOnly(options: { excludeThreadIds?: readonly string[] } = {}): string[] {
    return findWriteOnlyThreads(this.storePath, options);
  }

  remove(threadIds: readonly string[]): ReclaimSummary {
    return removeThreadState(this.storePath, threadIds);
  }

  /** Bytes stored under exactly these threads — what removing them would reclaim. */
  bytesOf(threadIds: readonly string[]): number {
    return [...factsOf(this.storePath, threadIds).values()].reduce((sum, f) => sum + f.bytes, 0);
  }

  /** The bytes the store occupies on disk, for the before/after of a prune. */
  diskBytes(): number {
    return storeDiskBytes(this.storePath);
  }

  close(): void {
    /* holds no connection between calls; kept so callers release it in the same shape */
  }
}

/** Fail-soft opener for {@link CheckpointMaintenance}; `null` when there is no store to maintain. */
export function openCheckpointMaintenance(storePath: string): CheckpointMaintenance | null {
  return CheckpointMaintenance.open(storePath);
}
