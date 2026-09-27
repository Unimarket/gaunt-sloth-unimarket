/**
 * @packageDocumentation
 * GS2-7 (B20) — local session history store.
 *
 * A **local SQLite** store that persists a compact record of each run BESIDE the existing
 * per-run `.md` logs, so `gth history search` / `gth insights` can look back over past sessions.
 * It is a **side-benefit, never a critical path**:
 *
 * - **Local only.** Nothing leaves the machine. The store lives under the user's global `~/.gsloth`
 *   dir (cross-project history), overridable via `history.dbPath`.
 * - **On unless turned off.** The recorder writes unless `history.enabled` is `false` (see
 *   `isHistoryEnabled` in `historyEnabled.ts`, the one switch it shares with the durable
 *   checkpointer).
 * - **Fail-soft.** {@link openHistoryStore} returns `null` if the store can't be opened, and every
 *   {@link HistoryStore} method catches its own errors and returns a safe default. A malformed or
 *   locked store therefore can never abort or alter a run — it just means no history for that run.
 *
 * GS2-121 — the store is a directory: this class reads and writes its `index.db`, and writes each
 * conversation's durable record into that conversation's own record file in the same commit. The
 * layout, what `history.dbPath` means, and why the index is only a cache are set out in
 * `historyLayout.ts`.
 *
 * Uses the built-in `node:sqlite` (Node ≥ 24) — zero native dependency, no build step — and its
 * bundled **FTS5** extension for full-text search (verified available at build time via an
 * `fts5` virtual table). No fallback path is needed on this runtime.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ConversationRef } from '#src/history/conversationRef.js';
import { threadFilePath } from '#src/history/historyLayout.js';
import {
  ensureThreadFile,
  openIndexDb,
  prepareHistoryStore,
  rebuildHistoryIndex,
  type IndexRebuildSummary,
} from '#src/history/historyFiles.js';
import { INDEX_SCHEMA_STEPS, closeQuietly, migrateFile } from '#src/history/historyMigrations.js';

// The layout's names stay internal (`historyLayout.ts`); only what this module always exported is
// re-exported, so the public surface grows by the rebuild and nothing else.
export { HISTORY_DB_FILENAME, resolveHistoryDbPath } from '#src/history/historyLayout.js';
export type { IndexRebuildSummary } from '#src/history/historyFiles.js';

/** A single persisted session record (all analytics fields optional; populated when available). */
export interface SessionRecord {
  /**
   * GS2-19 — the parent conversation this turn belongs to. When omitted, {@link HistoryStore.record}
   * opens a fresh single-turn conversation for the row (so a bare single-shot run = a 1-turn
   * conversation). Interactive sessions {@link HistoryStore.openConversation | open} one conversation
   * up-front and pass its id here on every turn, grouping the whole chat under one conversation.
   */
  conversationId?: number;
  /**
   * GS2-106 — the LangGraph thread a single-shot run checkpointed under. Used ONLY when this record
   * opens its own fresh conversation (no {@link conversationId}), and written onto that new row, so
   * the run's durable state is linked to the conversation it belongs to in the same transaction
   * that creates the row. Ignored when `conversationId` is given: an existing conversation already
   * carries its own link, and a turn must never move it.
   */
  threadId?: string;
  /** ISO-8601 timestamp; defaults to now when omitted. */
  ts?: string;
  /**
   * The PROJECT ROOT the turn was recorded under — every write site fills this from
   * `getProjectDir()`, which is the discovered config root when discovery matched above the
   * session, the `--config` override's own directory when one was given, and the working directory
   * only when neither applied.
   *
   * **It is not where the user was**, and the two coincide only in the common case: a session
   * opened in a subdirectory of a configured project records the PARENT. Nothing may render this
   * value under a phrase that places the session in it, and the row carries no second path to
   * recover the working directory from.
   */
  project?: string;
  /** Originating command (ask/chat/code/exec/…). */
  command?: string;
  /**
   * GS2-106 — the fan-out surface that started this run (`batch`, `eval`, `gth-batch`, `workflow`),
   * omitted for a direct run. Like {@link threadId}, written only when this record opens its own
   * fresh conversation.
   */
  origin?: string;
  /** Human-readable model/provider label. */
  model?: string;
  /** The user prompt / source that started the run (full-text indexed). */
  prompt?: string;
  /** The final assistant response text (full-text indexed). */
  response?: string;
  /** Prompt/input token count, when known. */
  tokensInput?: number;
  /** Completion/output token count, when known. */
  tokensOutput?: number;
  /** Estimated cost in USD, when known. */
  costUsd?: number;
  /** Names of tools invoked during the run, when known. */
  tools?: string[];
  /** Wall-clock duration of the run in milliseconds, when known. */
  durationMs?: number;
}

/** A search hit: the stored record plus its id and a highlighted snippet. */
export interface SessionSearchResult extends SessionRecord {
  id: number;
  ts: string;
  /** FTS5 snippet around the match (may be empty). */
  snippet: string;
}

/**
 * GS2-19 — metadata for a conversation (a group of turns). Passed to
 * {@link HistoryStore.openConversation} at interactive-session start.
 */
export interface ConversationMeta {
  /** ISO-8601 start timestamp; defaults to now when omitted. */
  ts?: string;
  /**
   * The PROJECT ROOT the conversation was opened under — `getProjectDir()` at the moment the row
   * was written, on the same terms as {@link SessionRecord.project}: the discovered config root,
   * the `--config` override's directory, or the working directory only as a fallback.
   *
   * **Not where the user was.** This is also the value a resume's workspace check compares against
   * the resuming session's own `getProjectDir()`, so what goes in here decides which conversations
   * a later session is allowed to reopen.
   */
  project?: string;
  /** Originating command (chat/code/ask/exec/…). */
  command?: string;
  /** Human-readable model/provider label. */
  model?: string;
  /**
   * GS2-20 — the LangGraph thread whose durable checkpoint holds this conversation's graph state.
   * It is the link a resume travels: `gth history list` prints conversation ids, and this is what
   * turns one of those back into the thread to re-enter. Omitted by callers that do not checkpoint,
   * leaving the conversation listable but not resumable. A single-shot run does not come through
   * here: {@link HistoryStore.record} opens its row and links its thread (see
   * {@link SessionRecord.threadId}).
   */
  threadId?: string;
}

/**
 * GS2-106 — what {@link HistoryStore.recordTurn} wrote: the turn's own row, and the conversation it
 * was recorded under with that conversation's run id.
 */
export interface RecordedTurn {
  /** The `sessions` row id — what {@link HistoryStore.record} has always returned. */
  sessionId: number;
  /** The conversation the turn was recorded under: supplied by the caller, or opened for it. */
  conversationId: number;
  /**
   * That conversation's run id, or `null` when it has none — a conversation that existed before
   * run ids did, and was passed in by the caller.
   */
  runId: string | null;
}

/**
 * GS2-19 — a conversation-grained listing row: the conversation's metadata plus the aggregate of
 * its turns (how many, the timespan they cover, and a preview of the last one). This is the
 * top-level unit `gth history list` shows, in place of isolated per-turn rows.
 */
export interface ConversationSummary {
  id: number;
  /** When the conversation was opened. */
  startedTs: string;
  /**
   * The conversation's PROJECT ROOT as recorded when it was opened — see
   * {@link ConversationMeta.project} for what that value is and, just as importantly, what it is
   * not. A surface rendering it must name it as the project root; it is not where the session was.
   */
  project?: string;
  command?: string;
  model?: string;
  /** Number of turns recorded under this conversation (0 for a conversation with no turns). */
  turnCount: number;
  /** Timestamp of the first / last turn, when any turns exist. */
  firstTs?: string;
  lastTs?: string;
  /** Prompt / response of the most recent turn (a one-line preview source). */
  lastPrompt?: string;
  lastResponse?: string;
  /**
   * GS2-20 — the LangGraph thread this conversation's checkpoint lives under, when it has one.
   * Absent for a conversation recorded without a checkpointer — any pre-GS2-20 row, a single-shot
   * run recorded before GS2-106 or whose store would not open — and for one whose link was cut
   * after a checkpoint write failed.
   */
  threadId?: string;
  /**
   * GS2-106 — the conversation's stable run id, minted when the row was created. Absent for a row
   * written before run ids existed; those stay addressable by {@link id}.
   */
  runId?: string;
  /**
   * GS2-106 — the fan-out surface that started the run (`batch`, `eval`, `gth-batch`, `workflow`);
   * absent for a direct run and for any row written before the column existed.
   */
  origin?: string;
}

/** Aggregate analytics over the whole store (local only). */
export interface HistoryInsights {
  sessionCount: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalTokens: number;
  totalCostUsd: number;
  /** Tool-name → invocation count, most-used first. */
  topTools: { tool: string; count: number }[];
  /** Command → run count, most-used first. */
  perCommand: { command: string; count: number }[];
  firstTs?: string;
  lastTs?: string;
}

/** Options for opening a store. */
export interface OpenHistoryStoreOptions {
  /**
   * When false (the default for read-only callers), a missing DB file yields `null` instead of
   * creating an empty database. Read commands pass `create: false` so `gth insights` never
   * materialises a DB as a side effect; the recorder passes `create: true`.
   */
  create?: boolean;
}

/** Escape a value for use inside an FTS5 double-quoted string token. */
function ftsQuote(term: string): string {
  return '"' + term.replace(/"/g, '""') + '"';
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: each whitespace-separated token is
 * wrapped as a quoted string and AND-ed together. This avoids FTS5 syntax errors from stray
 * operators (`AND`, `*`, `:`, parentheses, unbalanced quotes) in a user's query while still
 * matching all of their words.
 */
export function toFtsMatchQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map(ftsQuote).join(' AND ');
}

/**
 * A thin, fail-soft wrapper over a `node:sqlite` connection holding the session history.
 *
 * Obtain one via {@link openHistoryStore} (which returns `null` if the DB can't be opened). Every
 * method is defensive: on any SQLite error it returns a safe empty/zero result rather than
 * throwing, so callers on a run's hot path never have to guard.
 */
export class HistoryStore {
  private db: DatabaseSync;

  /**
   * The store directory, whose thread files hold each conversation's durable record; `null` for an
   * in-memory store (`:memory:`), which is an index alone.
   */
  private storePath: string | null;

  private constructor(db: DatabaseSync, storePath: string | null) {
    this.db = db;
    this.storePath = storePath;
  }

  /**
   * Open the store at `storePath`: split a single-file store from an earlier release, open and
   * migrate its index, and rebuild the index from the thread files when it is missing. Returns
   * `null` on any failure — nothing there when `create` is false, a split another process is
   * running, an unopenable/locked/corrupt index — so the caller can simply skip history without a
   * try/catch. `:memory:` opens an index with no thread files, for specs.
   */
  static open(storePath: string, options: OpenHistoryStoreOptions = {}): HistoryStore | null {
    const create = options.create ?? false;
    let db: DatabaseSync | null = null;
    try {
      if (storePath === ':memory:') {
        db = new DatabaseSync(':memory:');
        migrateFile(db, INDEX_SCHEMA_STEPS);
        return new HistoryStore(db, null);
      }
      if (prepareHistoryStore(storePath, { create }) !== 'ready') return null;
      db = openIndexDb(storePath, { create });
      if (!db) return null;
      return new HistoryStore(db, storePath);
    } catch {
      // GS2-42: a migration can throw after the OS-level file handle is already open (e.g. a
      // corrupt/garbage file — SQLite doesn't validate the header until the first statement
      // executes). Close it before returning null: on win32 an unclosed handle blocks the file from
      // being deleted/replaced/reopened until the process exits.
      closeQuietly(db ?? undefined);
      return null;
    }
  }

  /**
   * Run `write` with the record file of a conversation ATTACHed as `home`, so the writes to it
   * and to the index commit together. `write` is told whether `home` is there: an in-memory store,
   * or a conversation row with no home, writes the index alone.
   *
   * The file is created and migrated first, by its own short-lived connection, because an ATTACHed
   * file is not migrated by the connection that attaches it.
   */
  private withHome<T>(home: string | null, write: (attached: boolean) => T): T {
    if (this.storePath === null || home === null) return write(false);
    const path = ensureThreadFile(this.storePath, home);
    this.db.prepare(`ATTACH DATABASE ? AS home`).run(path);
    try {
      return write(true);
    } finally {
      try {
        this.db.exec('DETACH DATABASE home');
      } catch {
        /* a failed write may have left the connection unable to detach; closing it releases it */
      }
    }
  }

  /** The record file id of one conversation, or `null` when it has none or does not exist. */
  private homeOf(conversationId: number): string | null {
    const row = this.db
      .prepare(`SELECT home_thread FROM conversations WHERE id = ?`)
      .get(conversationId) as Record<string, unknown> | undefined;
    return row?.home_thread != null && String(row.home_thread).length > 0
      ? String(row.home_thread)
      : null;
  }

  /**
   * Whether the file of `threadId` exists — the read-time half of "an index row naming a missing
   * file is dropped": a conversation whose thread file is gone is listed and cannot be resumed.
   * Always true for an in-memory store, which has no files to lose.
   */
  private threadFileExists(threadId: string): boolean {
    return this.storePath === null || existsSync(threadFilePath(this.storePath, threadId));
  }

  /**
   * Create the file of the thread a new conversation names, before the index row that names it is
   * written — rule 1's "thread file first". Without it a conversation opened before its thread's
   * first checkpoint would read as having lost its thread, and a session that ends before its first
   * turn would leave a conversation that can never be resumed. Throws like `ensureThreadFile`; the
   * callers are fail-soft.
   */
  private ensureNamedThread(threadId: string | null | undefined): void {
    if (this.storePath === null || threadId == null || threadId.length === 0) return;
    ensureThreadFile(this.storePath, threadId);
  }

  /** A stored `thread_id` as the link a reader may follow, or `undefined` when there is none. */
  private liveThread(value: unknown): string | undefined {
    if (value == null) return undefined;
    const threadId = String(value);
    if (threadId.length === 0) return undefined;
    return this.threadFileExists(threadId) ? threadId : undefined;
  }

  /**
   * Write one conversation row into the index and its record file, in the transaction the caller
   * holds. Returns the new id.
   */
  private insertConversation(
    attached: boolean,
    row: {
      ts: string;
      project: string | null;
      command: string | null;
      model: string | null;
      threadId: string | null;
      runId: string;
      origin: string | null;
      home: string | null;
    }
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO conversations
           (started_ts, project, command, model, thread_id, run_id, origin, home_thread)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.ts,
        row.project,
        row.command,
        row.model,
        row.threadId,
        row.runId,
        row.origin,
        row.home
      );
    const id = Number(info.lastInsertRowid);
    if (attached) {
      this.db
        .prepare(
          `INSERT INTO home.conversation_records
             (id, started_ts, project, command, model, thread_id, run_id, origin)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, row.ts, row.project, row.command, row.model, row.threadId, row.runId, row.origin);
    }
    return id;
  }

  /**
   * GS2-19 — open a new conversation and return its id (or `null` on any error). Interactive
   * sessions call this once at start, then pass the id on every {@link record} so all the session's
   * turns group under it. A single-shot run does not need this: {@link record} opens a 1-turn
   * conversation itself when no `conversationId` is supplied.
   */
  openConversation(meta: ConversationMeta = {}): number | null {
    try {
      // GS2-121 — the conversation's record lives in a record file of its own, never in the file of
      // the thread it names, so a prune can delete that thread's file whole.
      const home = randomUUID();
      this.ensureNamedThread(meta.threadId);
      return this.withHome(home, (attached) =>
        this.inTransaction(() =>
          this.insertConversation(attached, {
            ts: meta.ts ?? new Date().toISOString(),
            project: meta.project ?? null,
            command: meta.command ?? null,
            model: meta.model ?? null,
            threadId: meta.threadId ?? null,
            runId: randomUUID(),
            origin: null,
            home,
          })
        )
      );
    } catch {
      return null;
    }
  }

  /** Run `work` in one transaction, rolled back on any error, which is rethrown. */
  private inTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* the failed statement may already have ended the transaction */
      }
      throw error;
    }
  }

  /**
   * GS2-106 — the conversation a parsed id names, as its integer row id, or `null` when it names
   * none. Every surface that takes a conversation id resolves it here.
   *
   * **Exact match, never a fallback and never a neighbour**, on the same terms as
   * {@link getConversationThreadId}: an integer must be a row that exists, and a run id must be
   * exactly the one minted for a row in THIS database. A run id from a database that was since
   * deleted and recreated therefore names nothing, which is the whole reason run ids exist.
   */
  resolveConversationRef(ref: ConversationRef): number | null {
    try {
      const row =
        ref.kind === 'id'
          ? (this.db.prepare(`SELECT id FROM conversations WHERE id = ?`).get(ref.id) as
              Record<string, unknown> | undefined)
          : (this.db.prepare(`SELECT id FROM conversations WHERE run_id = ?`).get(ref.runId) as
              Record<string, unknown> | undefined);
      return row?.id != null ? Number(row.id) : null;
    } catch {
      return null;
    }
  }

  /**
   * GS2-20 — the LangGraph thread one conversation's state is checkpointed under, or `null` when
   * that conversation does not exist or was never checkpointed.
   *
   * **Exact match on the id, and never a fallback.** A resume that answered a stale or mistyped id
   * with the newest conversation instead would silently drop the user into somebody else's
   * transcript, which is the one failure this lookup exists to make impossible; `null` is the
   * answer, and the caller says so.
   */
  getConversationThreadId(conversationId: number): string | null {
    try {
      const row = this.db
        .prepare(`SELECT thread_id FROM conversations WHERE id = ?`)
        .get(conversationId) as Record<string, unknown> | undefined;
      // GS2-121 — a thread whose file is gone is no thread: the link is dropped at read time.
      return this.liveThread(row?.thread_id) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * GS2-20 — cut a conversation's link to its LangGraph thread, so it can never be resumed again.
   *
   * Called when a checkpoint write has failed mid-session. What is on disk at that point is a
   * TRUNCATED but well-formed chain: the super-steps before the failure committed, the ones after
   * did not, and nothing about the rows says so. A resume would replay that half-conversation as
   * though it were the whole thing — a resume that looks right and is not, which is the one outcome
   * this ticket exists to prevent. Clearing the link is what makes the refusal durable; a flag in
   * the failing process dies with it and the NEXT process is the one that would be misled.
   *
   * `thread_id = NULL` rather than a sentinel: {@link getConversationThreadId} already answers
   * `null` for it, so every reader refuses for the same reason it refuses an unknown id, with no
   * new state to special-case. The cost is that "the writes failed" then looks identical to "this
   * conversation never had a thread" — a listing concern, not this one's, and both are correctly
   * un-resumable either way.
   *
   * Fail-soft like everything else here: a failure to record the failure must not raise a second
   * one into a session that is already degraded.
   */
  clearConversationThread(conversationId: number): void {
    // GS2-121 — cut in the record file too, or a rebuild of the index would restore the link
    // and make the truncated conversation resumable again. The write that failed was very likely
    // to this same disk, though, so when the two cannot be written together the index alone is
    // cut: that is the half every resume reads. The residual is stated at `historyLayout.ts`.
    try {
      const home = this.homeOf(conversationId);
      this.withHome(home, (attached) =>
        this.inTransaction(() => {
          this.db
            .prepare(`UPDATE conversations SET thread_id = NULL WHERE id = ?`)
            .run(conversationId);
          if (attached) {
            this.db
              .prepare(`UPDATE home.conversation_records SET thread_id = NULL WHERE id = ?`)
              .run(conversationId);
          }
        })
      );
      return;
    } catch {
      /* fall through to the index alone */
    }
    try {
      this.db.prepare(`UPDATE conversations SET thread_id = NULL WHERE id = ?`).run(conversationId);
    } catch {
      /* ignore: the session is already degrading; this must not add an error of its own */
    }
  }

  /**
   * GS2-20 — ONE conversation as a listing row, or `null` when there is no such id.
   *
   * Unlike {@link listConversations} this keeps a conversation with zero turns: a resume needs to
   * see the row for a session that opened and exited without an exchange, so it can refuse that id
   * for the right reason (no state was ever recorded) instead of calling it unknown. Fail-soft.
   */
  getConversation(conversationId: number): ConversationSummary | null {
    try {
      const r = this.db
        .prepare(
          `SELECT c.id AS id, c.started_ts AS started_ts, c.project AS project,
                  c.command AS command, c.model AS model, c.thread_id AS thread_id,
                  c.run_id AS run_id, c.origin AS origin,
                  COUNT(s.id) AS turn_count, MIN(s.ts) AS first_ts, MAX(s.ts) AS last_ts
             FROM conversations c
             LEFT JOIN sessions s ON s.conversation_id = c.id
            WHERE c.id = ?
            GROUP BY c.id`
        )
        .get(conversationId) as Record<string, unknown> | undefined;
      if (!r || r.id == null) return null;
      const last = this.db
        .prepare(
          `SELECT prompt, response FROM sessions
            WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`
        )
        .get(conversationId) as Record<string, unknown> | undefined;
      return {
        id: Number(r.id),
        startedTs: String(r.started_ts),
        project: r.project != null ? String(r.project) : undefined,
        command: r.command != null ? String(r.command) : undefined,
        model: r.model != null ? String(r.model) : undefined,
        turnCount: Number(r.turn_count ?? 0),
        firstTs: r.first_ts != null ? String(r.first_ts) : undefined,
        lastTs: r.last_ts != null ? String(r.last_ts) : undefined,
        lastPrompt: last?.prompt != null ? String(last.prompt) : undefined,
        lastResponse: last?.response != null ? String(last.response) : undefined,
        threadId: this.liveThread(r.thread_id),
        runId: r.run_id != null ? String(r.run_id) : undefined,
        origin: r.origin != null ? String(r.origin) : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * GS2-20 — the stored approval-grants document of one conversation, verbatim, or `null` when the
   * conversation has none (or does not exist). Opaque here: the approvals layer owns the format.
   */
  getConversationGrants(conversationId: number): string | null {
    try {
      const row = this.db
        .prepare(`SELECT grants FROM conversations WHERE id = ?`)
        .get(conversationId) as Record<string, unknown> | undefined;
      if (!row || row.grants == null) return null;
      const json = String(row.grants);
      return json.length > 0 ? json : null;
    } catch {
      return null;
    }
  }

  /**
   * GS2-20 — replace one conversation's stored approval-grants document (`null` clears it). Returns
   * whether the row was updated; `false` for an unknown id or any SQLite error. Fail-soft.
   */
  setConversationGrants(conversationId: number, grantsJson: string | null): boolean {
    try {
      return this.withHome(this.homeOf(conversationId), (attached) =>
        this.inTransaction(() => {
          const info = this.db
            .prepare(`UPDATE conversations SET grants = ? WHERE id = ?`)
            .run(grantsJson, conversationId);
          if (attached) {
            this.db
              .prepare(`UPDATE home.conversation_records SET grants = ? WHERE id = ?`)
              .run(grantsJson, conversationId);
          }
          return Number(info.changes) > 0;
        })
      );
    } catch {
      return false;
    }
  }

  /**
   * Persist one session and its full-text index entry. Returns the new `sessions` row id, or `null`
   * on any error (the run continues regardless). The two inserts run in a transaction so a failure
   * can't leave the FTS index out of sync with the base table.
   *
   * Returns the TURN's row id, which is not a conversation id; a caller that needs the conversation
   * the turn landed in uses {@link recordTurn}.
   */
  record(rec: SessionRecord): number | null {
    return this.recordTurn(rec)?.sessionId ?? null;
  }

  /**
   * GS2-106 — {@link record}, returning what was written: the turn's row id, and the conversation
   * the turn was recorded under together with that conversation's run id. A single-shot run needs
   * the conversation, which only exists from inside this transaction when it is opened here.
   * `null` on any error, like {@link record}.
   */
  recordTurn(rec: SessionRecord): RecordedTurn | null {
    try {
      const ts = rec.ts ?? new Date().toISOString();
      const tools = rec.tools && rec.tools.length > 0 ? JSON.stringify(rec.tools) : null;
      // GS2-121 — the turn's durable copy goes to its conversation's record file, in the same
      // commit as the index row. A fresh conversation gets a record file of its own.
      const existingId = rec.conversationId ?? null;
      const home = existingId == null ? randomUUID() : this.homeOf(existingId);
      if (existingId == null) this.ensureNamedThread(rec.threadId);
      return this.withHome(home, (attached) =>
        this.inTransaction((): RecordedTurn => {
          // GS2-19: every turn belongs to a conversation. When the caller opened one up-front
          // (interactive sessions), stamp it; otherwise open a fresh 1-turn conversation for this
          // row (single-shot runs / bare record() calls) so the turn is never left ungrouped.
          //
          // GS2-106: a fresh conversation is minted its run id here, and carries the single-shot
          // run's thread when one was checkpointed — written in the same transaction as the turn,
          // so there is no moment at which the row exists without its link.
          let conversationId = existingId;
          let runId: string | null;
          if (conversationId == null) {
            runId = randomUUID();
            conversationId = this.insertConversation(attached, {
              ts,
              project: rec.project ?? null,
              command: rec.command ?? null,
              model: rec.model ?? null,
              threadId: rec.threadId ?? null,
              runId,
              origin: rec.origin ?? null,
              home,
            });
          } else {
            const existing = this.db
              .prepare(`SELECT run_id FROM conversations WHERE id = ?`)
              .get(conversationId) as Record<string, unknown> | undefined;
            runId = existing?.run_id != null ? String(existing.run_id) : null;
          }
          const values = [
            ts,
            rec.project ?? null,
            rec.command ?? null,
            rec.model ?? null,
            rec.prompt ?? null,
            rec.response ?? null,
            rec.tokensInput ?? null,
            rec.tokensOutput ?? null,
            rec.costUsd ?? null,
            tools,
            rec.durationMs ?? null,
            conversationId,
          ] as const;
          const info = this.db
            .prepare(
              `INSERT INTO sessions
                 (ts, project, command, model, prompt, response,
                  tokens_input, tokens_output, cost_usd, tools, duration_ms, conversation_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(...values);
          const id = Number(info.lastInsertRowid);
          if (attached) {
            this.db
              .prepare(
                `INSERT INTO home.turn_records
                   (id, ts, project, command, model, prompt, response,
                    tokens_input, tokens_output, cost_usd, tools, duration_ms, conversation_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .run(id, ...values);
          }
          this.db
            .prepare(
              `INSERT INTO sessions_fts (rowid, prompt, response, command, project)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(id, rec.prompt ?? '', rec.response ?? '', rec.command ?? '', rec.project ?? '');
          return { sessionId: id, conversationId, runId };
        })
      );
    } catch {
      return null;
    }
  }

  /**
   * Full-text search over prompt/response/command/project, best match first (FTS5 `rank`). User
   * text is sanitised via {@link toFtsMatchQuery}; an empty or all-punctuation query returns `[]`.
   * Any SQLite error yields `[]` (fail-soft).
   */
  search(query: string, limit = 20): SessionSearchResult[] {
    const match = toFtsMatchQuery(query);
    if (!match) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT s.id AS id, s.ts AS ts, s.project AS project, s.command AS command,
                  s.model AS model, s.prompt AS prompt, s.response AS response,
                  s.tokens_input AS tokens_input, s.tokens_output AS tokens_output,
                  s.cost_usd AS cost_usd, s.tools AS tools, s.duration_ms AS duration_ms,
                  s.conversation_id AS conversation_id,
                  snippet(sessions_fts, 0, '[', ']', '…', 12) AS snippet
             FROM sessions_fts f
             JOIN sessions s ON s.id = f.rowid
            WHERE sessions_fts MATCH ?
            ORDER BY rank
            LIMIT ?`
        )
        .all(match, limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...rowToRecord(r),
        id: Number(r.id),
        ts: String(r.ts),
        snippet: String(r.snippet ?? ''),
      }));
    } catch {
      return [];
    }
  }

  /** Most recent sessions, newest first. Fail-soft ([] on error). */
  listRecent(limit = 20): SessionSearchResult[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, ts, project, command, model, prompt, response,
                  tokens_input, tokens_output, cost_usd, tools, duration_ms, conversation_id
             FROM sessions
            ORDER BY id DESC
            LIMIT ?`
        )
        .all(limit) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...rowToRecord(r),
        id: Number(r.id),
        ts: String(r.ts),
        snippet: '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * GS2-19 — conversations newest-first, each with its turn count, timespan, and a preview of the
   * last turn. This is the top-level unit for `gth history list` (the turn-grained {@link listRecent}
   * remains for callers that want raw turns). Fail-soft ([] on error).
   *
   * Empty conversations are **excluded** (`HAVING COUNT(s.id) > 0`): a session opens its conversation
   * at start (before any turn), so one that exits with zero turns would otherwise show as a
   * contentless `turnCount: 0` row. The LEFT JOIN still keeps every conversation that has ≥1 turn —
   * including back-filled 1-turn conversations, whose single turn satisfies the HAVING.
   */
  listConversations(limit = 20): ConversationSummary[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT c.id AS id, c.started_ts AS started_ts, c.project AS project,
                  c.command AS command, c.model AS model, c.thread_id AS thread_id,
                  c.run_id AS run_id, c.origin AS origin,
                  COUNT(s.id) AS turn_count, MIN(s.ts) AS first_ts, MAX(s.ts) AS last_ts
             FROM conversations c
             LEFT JOIN sessions s ON s.conversation_id = c.id
            GROUP BY c.id
           HAVING COUNT(s.id) > 0
            ORDER BY c.id DESC
            LIMIT ?`
        )
        .all(limit) as Record<string, unknown>[];
      const lastTurn = this.db.prepare(
        `SELECT prompt, response FROM sessions
          WHERE conversation_id = ? ORDER BY id DESC LIMIT 1`
      );
      return rows.map((r) => {
        const last = lastTurn.get(Number(r.id)) as Record<string, unknown> | undefined;
        return {
          id: Number(r.id),
          startedTs: String(r.started_ts),
          project: r.project != null ? String(r.project) : undefined,
          command: r.command != null ? String(r.command) : undefined,
          model: r.model != null ? String(r.model) : undefined,
          turnCount: Number(r.turn_count ?? 0),
          firstTs: r.first_ts != null ? String(r.first_ts) : undefined,
          lastTs: r.last_ts != null ? String(r.last_ts) : undefined,
          lastPrompt: last?.prompt != null ? String(last.prompt) : undefined,
          lastResponse: last?.response != null ? String(last.response) : undefined,
          threadId: this.liveThread(r.thread_id),
          runId: r.run_id != null ? String(r.run_id) : undefined,
          origin: r.origin != null ? String(r.origin) : undefined,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * GS2-19 — all turns of one conversation in chronological (insert) order, so a search hit can be
   * expanded into the whole thread it belonged to. Fail-soft ([] on error / unknown id).
   */
  getConversationThread(conversationId: number): SessionRecord[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, ts, project, command, model, prompt, response,
                  tokens_input, tokens_output, cost_usd, tools, duration_ms, conversation_id
             FROM sessions
            WHERE conversation_id = ?
            ORDER BY id ASC`
        )
        .all(conversationId) as Record<string, unknown>[];
      return rows.map((r) => rowToRecord(r));
    } catch {
      return [];
    }
  }

  /**
   * Aggregate token/cost totals, a top-tool tally, and a per-command breakdown over the whole
   * store. Tool tallying reads each row's JSON `tools` array in JS (robust to nulls). Fail-soft:
   * returns a zeroed summary on any error.
   */
  insights(topN = 10): HistoryInsights {
    const empty: HistoryInsights = {
      sessionCount: 0,
      totalTokensInput: 0,
      totalTokensOutput: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      topTools: [],
      perCommand: [],
    };
    try {
      const agg = this.db
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(tokens_input), 0) AS ti,
                  COALESCE(SUM(tokens_output), 0) AS to_,
                  COALESCE(SUM(cost_usd), 0) AS cost,
                  MIN(ts) AS first_ts,
                  MAX(ts) AS last_ts
             FROM sessions`
        )
        .get() as Record<string, unknown>;

      const perCommandRows = this.db
        .prepare(
          `SELECT command, COUNT(*) AS n
             FROM sessions
            WHERE command IS NOT NULL AND command <> ''
            GROUP BY command
            ORDER BY n DESC, command ASC`
        )
        .all() as Record<string, unknown>[];

      const toolRows = this.db
        .prepare(`SELECT tools FROM sessions WHERE tools IS NOT NULL AND tools <> ''`)
        .all() as Record<string, unknown>[];

      const toolCounts = new Map<string, number>();
      for (const row of toolRows) {
        let names: unknown;
        try {
          names = JSON.parse(String(row.tools));
        } catch {
          continue;
        }
        if (!Array.isArray(names)) continue;
        for (const name of names) {
          if (typeof name !== 'string' || name.length === 0) continue;
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        }
      }
      const topTools = [...toolCounts.entries()]
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
        .slice(0, topN);

      const ti = Number(agg.ti ?? 0);
      const to = Number(agg.to_ ?? 0);
      return {
        sessionCount: Number(agg.n ?? 0),
        totalTokensInput: ti,
        totalTokensOutput: to,
        totalTokens: ti + to,
        totalCostUsd: Number(agg.cost ?? 0),
        topTools,
        perCommand: perCommandRows.map((r) => ({
          command: String(r.command),
          count: Number(r.n),
        })),
        firstTs: agg.first_ts ? String(agg.first_ts) : undefined,
        lastTs: agg.last_ts ? String(agg.last_ts) : undefined,
      };
    } catch {
      return empty;
    }
  }

  /** Close the underlying connection (fail-soft). */
  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Map a raw DB row (snake_case columns) to a {@link SessionRecord}. */
function rowToRecord(r: Record<string, unknown>): SessionRecord {
  let tools: string[] | undefined;
  if (r.tools != null && r.tools !== '') {
    try {
      const parsed = JSON.parse(String(r.tools));
      if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      /* ignore malformed tools JSON */
    }
  }
  return {
    conversationId: r.conversation_id != null ? Number(r.conversation_id) : undefined,
    ts: r.ts != null ? String(r.ts) : undefined,
    project: r.project != null ? String(r.project) : undefined,
    command: r.command != null ? String(r.command) : undefined,
    model: r.model != null ? String(r.model) : undefined,
    prompt: r.prompt != null ? String(r.prompt) : undefined,
    response: r.response != null ? String(r.response) : undefined,
    tokensInput: r.tokens_input != null ? Number(r.tokens_input) : undefined,
    tokensOutput: r.tokens_output != null ? Number(r.tokens_output) : undefined,
    costUsd: r.cost_usd != null ? Number(r.cost_usd) : undefined,
    tools,
    durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
  };
}

/**
 * Fail-soft open of the history store. Returns `null` (never throws) when the store can't be opened
 * or, for read-only callers (`create: false`, the default), when nothing is there yet.
 */
export function openHistoryStore(
  dbPath: string,
  options: OpenHistoryStoreOptions = {}
): HistoryStore | null {
  return HistoryStore.open(dbPath, options);
}

/**
 * GS2-121 — rebuild the index of the store at `storePath` from its thread files alone, which is
 * what `gth history rebuild` runs. Splits a single-file store first, like any open. `null` when
 * there is no store there or it could not be rebuilt; never throws.
 */
export function rebuildHistoryIndexSafe(storePath: string): IndexRebuildSummary | null {
  try {
    if (prepareHistoryStore(storePath, { create: false }) !== 'ready') return null;
    return rebuildHistoryIndex(storePath);
  } catch {
    return null;
  }
}
