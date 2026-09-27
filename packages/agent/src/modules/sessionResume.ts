/**
 * @packageDocumentation
 * GS2-20 — **the one seam through which a session re-enters a stored conversation.**
 *
 * Its spellings — `--resume <id>` on `gth chat` / `gth code` / bare `gth`, `/resume <id>` inside a
 * running session, `gth history resume <id>`, and (GS2-106) `gth ask --resume <id>` and
 * `gth exec --resume <id>` — all go through {@link resolveResumeTarget}. The interactive ones are
 * exactly two calls: {@link resolveResumeTarget} decides whether the conversation CAN be resumed and gathers what
 * a resume needs, and {@link applyResumeTarget} makes the session be in it. Neither surface (the
 * readline loop, the Ink TUI) knows anything a resume requires beyond those two calls, so a check
 * added here is applied to every spelling, and a spelling cannot drift into meaning something else.
 *
 * The seam sits here, in the agent package, rather than wholly on `GthAgentRunner`, because half of
 * what a resume does is not the runner's: reading the history store, comparing workspaces and
 * re-binding the recorder are session concerns the runner deliberately does not have. The runner
 * owns the half that touches the graph — `GthAgentRunner.resumeConversation` rotates onto the
 * stored thread and installs the conversation's grants — and this module owns the checks and the
 * recorder. Both halves are exercised by both spellings, so breaking either breaks both.
 *
 * **The checks run in a fixed order, and each refusal has its own sentence**, because the person
 * typing an id needs to know which of five different things is wrong, and "cannot resume" tells
 * them none of it:
 *
 * 1. history is off — the one switch that governs recording, checkpointing and resuming alike;
 * 2. the store did not open — asked for and not available, which is a different fact from off;
 * 3. no such conversation — the id, integer or run id, names no row in THIS store;
 * 4. the conversation exists and is not resumable — the resume matrix refuses it on this surface
 *    (a fan-out cell, or a command with no row), it never had a thread, lost it, its thread was never
 *    checkpointed, or (a GS2-106 cell only) its thread ends on an unanswered tool call — with the
 *    reason class where it is known;
 * 5. it was recorded in another directory — the same comparison ACP's `session/new` makes.
 */
import { resolve } from 'node:path';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import {
  isHistoryEnabled,
  type HistoryConfigView,
} from '@gaunt-sloth/core/history/historyEnabled.js';
import {
  listResumableConversationsSafe,
  lookupConversationSafe,
  resolveConversationRefSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import {
  resumeMatrixVerdict,
  threadTail,
  type ResumeSurface,
} from '@gaunt-sloth/core/history/resumeMatrix.js';
import {
  formatConversationRef,
  toConversationRef,
  type ConversationRef,
} from '@gaunt-sloth/core/history/conversationRef.js';
import type { ConversationSummary, SessionRecord } from '@gaunt-sloth/core/history/historyStore.js';
import { formatConversationList } from '@gaunt-sloth/core/history/historyFormat.js';
import {
  loadConversationGrantsSafe,
  type ConversationGrants,
} from '@gaunt-sloth/core/core/approvals/conversationGrants.js';
import { isSameWorkspace } from '#src/modules/workspace.js';
import type { SlashCommandNotice } from '#src/modules/slashCommands.js';

/** Everything a resume needs, gathered by {@link resolveResumeTarget} once the checks have passed. */
export interface ResumeTarget {
  conversationId: number;
  /** The LangGraph thread whose checkpoint holds the conversation's state. */
  threadId: string;
  summary: ConversationSummary;
  /** The recorded turns, oldest first — what the surfaces replay as restored turns. */
  turns: SessionRecord[];
  /**
   * The approvals granted in the conversation, to install again (Ruling 3) — on the interactive
   * surface only. GS2-106: a non-interactive resume never restores stored grants, so for every other
   * surface this is empty and the store's grants are never read.
   */
  grants: ConversationGrants;
}

/** Why a resume was refused — one variant per check, each with what its sentence needs. */
export type ResumeRefusal =
  | { kind: 'history-off' }
  | { kind: 'store-unavailable' }
  | {
      kind: 'unknown';
      /**
       * What the person typed, parsed — an integer or a run id. Kept as the reference rather than
       * an integer because a run id that names nothing has no integer to report.
       */
      ref: ConversationRef;
    }
  | {
      kind: 'not-resumable';
      id: number;
      /**
       * The reason class, where it is known:
       * - `fan-out` — one cell of a `batch`, `eval`, `gth-batch` or `workflow` run (the row has an
       *   `origin`). GS2-106: whether a single cell can be resumed is not decided (GS2-118);
       * - `unsupported-command` — recorded by a command the resume matrix has no row for
       *   (`review`, `pr`, …);
       * - `no-thread` — a conversation whose thread link is null: a checkpoint write failed while
       *   it ran and it was marked unresumable, or it predates conversation state;
       * - `no-checkpoint` — the thread is on record but nothing was ever checkpointed under it;
       * - `pending-tool-call` — GS2-106: the stored thread ends on a tool call that was never
       *   answered, as a run that stopped at an approval stop leaves it;
       * - `unreadable` — the checkpoint could not be read from the store.
       */
      reason:
        | 'fan-out'
        | 'unsupported-command'
        | 'no-thread'
        | 'no-checkpoint'
        | 'pending-tool-call'
        | 'unreadable';
      command?: string;
      /** The fan-out surface, for `fan-out`. */
      origin?: string;
    }
  | { kind: 'workspace-mismatch'; id: number; stored: string; current: string }
  /** The id resolved to the conversation the session is already in — only for a run id; see below. */
  | { kind: 'same-conversation'; id: number };

export type ResumeResolution =
  { ok: true; target: ResumeTarget } | { ok: false; refusal: ResumeRefusal };

/** What {@link resolveResumeTarget} needs from the session asking. */
export interface ResumeSessionContext {
  config: HistoryConfigView;
  /** The session's checkpointer — the saver the thread is looked up in, and whether it is durable. */
  checkpointer: { saver: BaseCheckpointSaver; durable: boolean };
  /**
   * This session's PROJECT ROOT — `getProjectDir()`, the same accessor the conversation's stored
   * `project` was written from, compared with it below.
   *
   * It is **not** the directory the session works in, and the two differ whenever config discovery
   * matched above the session or a `--config` override moved the root. Both sides of the
   * comparison answering the same question is what makes the refusal coherent; feeding a working
   * directory in on one side and a project root on the other would change which conversations
   * resume reopens.
   */
  workspace: string;
  /**
   * The conversation this session is recording under, when it has one. A run id cannot be compared
   * with it before it is resolved, so the seam makes that comparison itself; the surfaces keep their
   * own integer check for the form they can compare up-front.
   */
  current?: number;
}

/**
 * Decide whether the conversation `ref` names can be resumed by this session, and gather what the
 * resume needs. Never throws: a failure to read is a refusal with a reason, never a crash.
 *
 * `ref` is a parsed conversation id — `parseConversationRef` in core — or a bare integer id. It is
 * resolved to a row HERE, after the history and store checks, by exact match: this is the one place
 * a resume turns what a person typed into a conversation, whichever surface they typed it on.
 *
 * GS2-106 — `surface` is where the resume was asked for, and it is required so that no caller can
 * forget to say: the resume matrix in core decides per surface, and grants are restored only on the
 * interactive one.
 */
export async function resolveResumeTarget(
  session: ResumeSessionContext,
  ref: ConversationRef | number,
  surface: ResumeSurface
): Promise<ResumeResolution> {
  if (!isHistoryEnabled(session.config)) return refuse({ kind: 'history-off' });
  // Asked for and not available: the store did not open, so nothing below could be read anyway,
  // and calling the id "unknown" would blame the person for the disk.
  if (!session.checkpointer.durable) return refuse({ kind: 'store-unavailable' });

  const parsed = toConversationRef(ref);
  const id = resolveConversationRefSafe(session.config, parsed);
  if (id === null) return refuse({ kind: 'unknown', ref: parsed });
  const stored = lookupConversationSafe(session.config, id);
  if (!stored) return refuse({ kind: 'unknown', ref: parsed });
  const { summary, turns } = stored;
  if (session.current !== undefined && id === session.current) {
    return refuse({ kind: 'same-conversation', id });
  }

  // GS2-106 — the resume matrix decides, by the recorded command and origin, before the thread: a
  // single-shot run carries a thread and a checkpoint exactly as an interactive session does, so
  // the thread no longer says what the conversation was. The table and why each cell is what it is
  // are in core's `resumeMatrix.ts`; this is the one place a resume asks it.
  const verdict = resumeMatrixVerdict(summary, surface);
  if (!verdict.ok) {
    // Refused on every surface alike: a fan-out cell (its command column names the MODE the cell
    // ran under, so the origin is what identifies it) or a command with no row in the matrix.
    return refuse({
      kind: 'not-resumable',
      id,
      reason: verdict.reason,
      command: summary.command,
      ...(verdict.reason === 'fan-out' ? { origin: verdict.origin } : {}),
    });
  }
  if (!summary.threadId) {
    return refuse({ kind: 'not-resumable', id, reason: 'no-thread', command: summary.command });
  }
  // A thread with no checkpoint is refused exactly like a null thread: there is no state to
  // re-enter, and driving the graph on it would silently start a fresh conversation under an old
  // id — which is the one thing a resume must never do.
  let tuple: Awaited<ReturnType<BaseCheckpointSaver['getTuple']>>;
  try {
    tuple = await session.checkpointer.saver.getTuple({
      configurable: { thread_id: summary.threadId },
    });
  } catch {
    return refuse({ kind: 'not-resumable', id, reason: 'unreadable', command: summary.command });
  }
  if (tuple === undefined) {
    return refuse({ kind: 'not-resumable', id, reason: 'no-checkpoint', command: summary.command });
  }
  // GS2-106 — a cell this node added also needs the thread to END cleanly. A run that stopped at an
  // approval nobody could answer leaves an assistant tool call with no result; appending a user
  // message to that sends the model a history real providers reject, so it is refused here rather
  // than failing inside the provider. The existing GS2-20 cell (a chat/code conversation resumed
  // interactively) is deliberately left as it was; the matrix marks which cells check.
  if (verdict.requireCleanTail && threadTail(tuple) !== 'clean') {
    return refuse({
      kind: 'not-resumable',
      id,
      reason: 'pending-tool-call',
      command: summary.command,
    });
  }

  // The same comparison ACP's `session/new` makes, on resolved paths. A row with no project on
  // record has nothing to compare and proceeds: the check refuses a KNOWN mismatch, and a datum
  // that was never written is not one.
  if (summary.project) {
    const stored = resolve(summary.project);
    const current = resolve(session.workspace);
    if (!isSameWorkspace(stored, current)) {
      return refuse({ kind: 'workspace-mismatch', id, stored, current });
    }
  }

  return {
    ok: true,
    target: {
      conversationId: id,
      threadId: summary.threadId,
      summary,
      turns,
      // GS2-106 — Andrew's ruling: a non-interactive resume never restores stored grants. The
      // store is not even read for one, so no later change to how a target is applied can carry
      // grants a person made while watching into a run nobody is watching.
      grants:
        surface === 'interactive'
          ? loadConversationGrantsSafe(session.config, id)
          : { allow: [], deny: [] },
    },
  };
}

const refuse = (refusal: ResumeRefusal): ResumeResolution => ({ ok: false, refusal });

/** The half of the runner a resume drives — `GthAgentRunner` satisfies it; specs pass a fake. */
export interface ResumableRunner {
  resumeConversation(target: {
    threadId: string;
    grants: ConversationGrants;
  }): void | Promise<void>;
}

/**
 * Make the session BE in the resolved conversation: the runner rotates onto the stored thread and
 * installs the conversation's grants, and the checkpointer is told which row to mark if a write
 * fails from here on. The caller switches its own recorder id to `target.conversationId`, because
 * that id is the caller's variable; nothing else is needed.
 *
 * Rejects when the runner refuses — a turn still running, or a tool approval still pending on the
 * thread being left — and then nothing has moved: the checkpointer is bound only after the runner
 * has actually rotated, so a refused resume leaves the session exactly where it was.
 */
export async function applyResumeTarget(
  session: {
    runner: ResumableRunner;
    checkpointer: { bindConversation?(conversationId: number | undefined): void };
  },
  target: ResumeTarget
): Promise<void> {
  await session.runner.resumeConversation({ threadId: target.threadId, grants: target.grants });
  session.checkpointer.bindConversation?.(target.conversationId);
}

/**
 * The conversations a bare `/resume` offers: every resumable one except the conversation the
 * session is already in. Fail-soft and empty when history is off or the store is absent.
 */
export function listResumeCandidates(
  config: HistoryConfigView,
  currentConversationId: number | undefined,
  limit = 20
): ConversationSummary[] {
  return listResumableConversationsSafe(config, { limit, exclude: currentConversationId });
}

// ── Notices — shared by both surfaces so one refusal has one sentence. ────────────────────────────

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * The banner a resumed session shows first: which conversation, when it started, how much of it is
 * on record, and under which command and model — the facts a person needs to confirm they picked
 * the right id. It also states the one thing a resume changes that nothing on screen shows: the
 * approvals granted in that conversation are in force again.
 *
 * **The stored `project` is named as the conversation's PROJECT ROOT, and never as where the
 * session was.** It is `getProjectDir()` as of the moment the conversation was opened: the
 * discovered config root when discovery matched above the session, the `--config` override's own
 * directory when one was given, and the working directory only when neither applied. So a session
 * opened in a subdirectory of a configured project recorded its PARENT, and a sentence placing the
 * session *in* that path is false for exactly the user who most needs it right, while reading
 * perfectly for everyone whose config sat where they opened the session.
 *
 * Where the user actually was is not recoverable here — the row holds one path, and its provenance
 * is not on it — so this banner claims nothing about it. What it does hold is the value the
 * workspace-mismatch refusal gates on, which is the fact worth printing beside the id.
 */
export function resumedConversationNotice(target: ResumeTarget): SlashCommandNotice {
  const { summary } = target;
  const recorded = `${plural(summary.turnCount, 'turn')} recorded under gth ${summary.command ?? 'chat'}`;
  const model = summary.model ? `, with ${summary.model}` : '';
  return {
    title: `Resumed conversation #${target.conversationId}`,
    lines: [
      `Started ${summary.startedTs}${summary.project ? `, with project root ${summary.project}` : ''}.`,
      `${recorded}${model}.`,
      target.turns.length > 0
        ? 'The recorded turns are shown below; the model continues from where it left off.'
        : 'No turns were recorded yet; the model continues from where it left off.',
      'Approvals you granted in it are in force again, and new ones will be kept with it.',
    ],
  };
}

/**
 * The sentence for each refusal. One title states what did not happen and why; the body says what
 * to do instead. `inSession` picks the pointer: the slash commands a running session has, or the
 * CLI commands a shell has.
 */
export function resumeRefusalNotice(
  refusal: ResumeRefusal,
  options: { inSession?: boolean } = {}
): SlashCommandNotice {
  const list = options.inSession ? '/resume with no id' : '`gth history list`';
  switch (refusal.kind) {
    case 'history-off':
      return {
        title: 'Cannot resume: history is off',
        lines: [
          'Recording is on by default; `history.enabled: false` in your config turns it off, and ' +
            'this session has it off. Only a recorded conversation can be resumed.',
          'Remove that key, or set it to true, and start again.',
        ],
        tone: 'warn',
      };
    case 'store-unavailable':
      return {
        title: 'Cannot resume: the conversation store did not open',
        lines: [
          'The history database could not be opened, so nothing can be read from it; the notice ' +
            'about the store says why.',
          'Nothing was changed.',
        ],
        tone: 'warn',
      };
    case 'unknown':
      return {
        title: `No conversation ${formatConversationRef(refusal.ref)}`,
        lines: [
          'There is no conversation with that id in the history store.',
          `Run ${list} to see the ones that can be resumed.`,
        ],
        tone: 'warn',
      };
    case 'not-resumable': {
      // GS2-106 — the first three are the resume matrix's refusals and the thread-tail check; each
      // says what the conversation is and that this is a rule, not a fault, since the person can do
      // nothing about it but read the transcript.
      const why =
        refusal.reason === 'fan-out'
          ? `It is one cell of a \`gth ${refusal.origin ?? 'batch'}\` run. Resuming a single ` +
            'cell of a batch, eval or workflow run is not supported.'
          : refusal.reason === 'unsupported-command'
            ? `It was recorded by \`gth ${refusal.command ?? 'unknown'}\`, which cannot be ` +
              'resumed. Only conversations recorded by `ask`, `exec`, `chat` or `code` can be.'
            : refusal.reason === 'pending-tool-call'
              ? 'Its last turn stopped at a tool call that was never answered — the run ended at ' +
                'an approval stop — so there is no finished turn to continue from.'
              : refusal.reason === 'no-thread'
                ? 'Its conversation state is not on record: either a checkpoint write failed while it ' +
                  'was running and it was marked unresumable, or it was recorded before conversation ' +
                  'state was kept.'
                : refusal.reason === 'no-checkpoint'
                  ? // GS2-107 — two ways to arrive here, and the sentence has to be true of both: the
                    // session ended before it wrote anything, or `gth history prune` removed the state
                    // afterwards. Nothing on the row distinguishes them, so neither is claimed.
                    'Its conversation state is not in the store — either the session ended before its ' +
                    'first turn completed, or `gth history prune` has since removed it.'
                  : 'Its conversation state could not be read from the store.';
      return {
        title: `Conversation #${refusal.id} cannot be resumed`,
        lines: [why, `You can still read it with \`gth history show ${refusal.id}\`.`],
        tone: 'warn',
      };
    }
    case 'workspace-mismatch':
      return {
        title: `Conversation #${refusal.id} belongs to another project`,
        lines: [
          `It was recorded in ${refusal.stored}, and this session is in ${refusal.current}.`,
          // GS2-114 — no mechanism sentence here, deliberately. What decides this refusal is the
          // comparison in `resolveResumeTarget`: the resolved project root recorded with the
          // conversation against this session's. Tools and file paths do not enter into it and
          // follow the working directory, which is neither of those two paths — so a sentence
          // pointing them at the stored directory states a reason the code does not have, on copy
          // a person plans their next move from. The rule and the remedy are enough.
          'A conversation is resumed from the directory it was recorded in. Change to that ' +
            'directory and run it again.',
          'Nothing was changed.',
        ],
        tone: 'warn',
      };
    case 'same-conversation':
      return resumeSameConversationNotice(refusal.id);
  }
}

/**
 * A bare `/resume`: the conversations this session could move to, and how — as text.
 *
 * This is the **readline** session's answer, and the empty case for every surface. It is not a
 * picker and must not describe one: the Ink TUI offers an arrow-key list instead (GS2-112), and a
 * sentence about moving a highlight or pressing Enter would be false on the surface this builder
 * actually serves, which has neither. Ids are how a conversation is named here, which is why the
 * closing line names the commands that take one.
 */
export function resumableConversationsNotice(
  candidates: ConversationSummary[]
): SlashCommandNotice {
  if (candidates.length === 0) {
    return {
      title: 'No other conversation can be resumed',
      lines: [
        'Only a conversation recorded by `ask`, `exec`, `chat` or `code` that completed at least ' +
          'one turn can be resumed, and this session is not offered to itself.',
        'Nothing was changed.',
      ],
    };
  }
  return {
    title: 'Conversations you can resume',
    lines: [
      ...formatConversationList(candidates),
      'Resume one with /resume <id>. Later, from a shell, `gth history resume <id>` does the same.',
    ],
  };
}

/** `/resume <id>` naming the conversation the session is already in: nothing to do, and said so. */
export function resumeSameConversationNotice(id: number): SlashCommandNotice {
  return {
    title: `Already in conversation #${id}`,
    lines: ['This session is recording under that conversation now.', 'Nothing was changed.'],
  };
}

/** `/resume` on a surface with no conversation store behind it (the fixture agent). */
export function resumeUnavailableNotice(): SlashCommandNotice {
  return {
    title: 'Resume unavailable',
    lines: ['This session has no conversation store to resume from.', 'Nothing was changed.'],
    tone: 'warn',
  };
}

/** A resume whose apply step threw. The session is left in the conversation it was in. */
export function resumeFailedNotice(reason: string): SlashCommandNotice {
  return {
    title: 'Resume did not happen',
    lines: [`The session was left where it was: ${reason}`],
    tone: 'warn',
  };
}
