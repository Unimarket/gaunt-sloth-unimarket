/**
 * @packageDocumentation
 * GS2-106 — **the one table that says which command can pick up which conversation**, and the one
 * check on a stored thread that decides whether it can take another user message.
 *
 * ## Why one table, here
 *
 * A conversation can be resumed from four places: `gth ask --resume`, `gth exec --resume -m`, an
 * interactive session (`gth chat`/`gth code --resume`, `/resume` and its picker), and
 * `gth history resume`. If each of them decided for itself, the answer to "can I resume #12 from
 * here?" would differ between surfaces the first time one of them was edited, and a person would
 * learn the rule from whichever refusal they hit first. So every surface asks {@link
 * resumeMatrixVerdict}, the `/resume` picker filters with it, and the root `--resume` derives the
 * subcommands it may ride along with from {@link RESUME_SURFACE_OF_SUBCOMMAND}. Nothing keeps a list
 * of its own.
 *
 * It lives in core rather than beside the resume seam in the agent package because core has to
 * read it too — the picker's listing is a core function, and core cannot import the agent package.
 *
 * ## What the table says
 *
 * - Rows are the command a conversation was RECORDED as (`conversations.command`). Only `ask`,
 *   `exec`, `chat` and `code` are rows; a conversation recorded by any other command (`review`,
 *   `pr`, …) is refused everywhere, because nothing defines what continuing one would mean.
 * - A conversation with an `origin` — one cell of a `batch`, `eval`, `gth-batch` or `workflow` run —
 *   is refused everywhere, whatever its command says. The command column holds the MODE the cell
 *   ran under, so without the origin such a row looks exactly like a direct `ask`/`exec`. Whether a
 *   single cell can be resumed at all is an open question (GS2-118); until it is answered the
 *   refusal says so and points at `gth history show`.
 * - Every cell of the four-by-four grid resumes. `chat`/`code` into `exec --resume` is allowed
 *   because a non-interactive resume never restores the conversation's stored approval grants
 *   (Andrew, 2026-09-27): the grants a person made while watching an interactive session cannot
 *   travel into an unattended run by this route, which was the only reason to refuse that cell.
 * - A cell is either the existing GS2-20 cell — a `chat`/`code` conversation resumed interactively,
 *   left exactly as it was — or a cell this node added, which additionally requires the stored
 *   thread to end cleanly ({@link threadTail}). See {@link ResumeCell}.
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { CheckpointTuple } from '@langchain/langgraph';

/**
 * Where a resume is asked for. `interactive` is every spelling that lands in a `chat`/`code`
 * session; `history` is `gth history resume`, which always runs the conversation as the command it
 * was recorded under.
 */
export const RESUME_SURFACES = ['ask', 'exec', 'interactive', 'history'] as const;
export type ResumeSurface = (typeof RESUME_SURFACES)[number];

/** The commands a conversation can have been recorded as and still be resumed. */
export const RESUMABLE_RECORDED_COMMANDS = ['ask', 'exec', 'chat', 'code'] as const;
export type ResumableRecordedCommand = (typeof RESUMABLE_RECORDED_COMMANDS)[number];

/**
 * One cell of the matrix.
 *
 * - `resume` — the existing GS2-20 cell, unchanged: an interactive conversation re-entered as an
 *   interactive session.
 * - `resume-if-clean` — a cell this node added. It resumes only when the stored thread does not end
 *   on a tool call that was never answered. Such a thread is what a run leaves when it stopped at
 *   an approval it could not ask anyone about; appending a user message to it sends the model an
 *   assistant tool call with no result, which real providers reject (measured on GS2-106 Task 2,
 *   `handoff/gs2-106-2-interrupt-probe.out`). GS2-20's own cell is left alone on purpose; its
 *   exposure is a separate follow-up.
 */
export type ResumeCell = 'resume' | 'resume-if-clean';

/**
 * THE table. Read by {@link resumeMatrixVerdict} only; see the module docblock for why each cell is
 * what it is.
 */
export const RESUME_MATRIX: Readonly<
  Record<ResumableRecordedCommand, Readonly<Record<ResumeSurface, ResumeCell>>>
> = {
  ask: {
    ask: 'resume-if-clean',
    exec: 'resume-if-clean',
    interactive: 'resume-if-clean',
    history: 'resume-if-clean',
  },
  exec: {
    ask: 'resume-if-clean',
    exec: 'resume-if-clean',
    interactive: 'resume-if-clean',
    history: 'resume-if-clean',
  },
  chat: {
    ask: 'resume-if-clean',
    exec: 'resume-if-clean',
    interactive: 'resume',
    history: 'resume',
  },
  code: {
    ask: 'resume-if-clean',
    exec: 'resume-if-clean',
    interactive: 'resume',
    history: 'resume',
  },
};

/**
 * The subcommands a `--resume <id>` may be given to, and the surface each one is. The root
 * `gth --resume <id> <subcommand>` derives the set it accepts from this map's keys.
 */
export const RESUME_SURFACE_OF_SUBCOMMAND: Readonly<Record<string, ResumeSurface>> = {
  ask: 'ask',
  exec: 'exec',
  chat: 'interactive',
  code: 'interactive',
};

/** What the matrix says about one conversation on one surface. */
export type ResumeMatrixVerdict =
  | {
      ok: true;
      /** Whether the stored thread must also end cleanly ({@link threadTail}) for this cell. */
      requireCleanTail: boolean;
    }
  | { ok: false; reason: 'fan-out'; origin: string; command?: string }
  | { ok: false; reason: 'unsupported-command'; command?: string };

/** The two columns of a conversation row the matrix reads. */
export interface ResumeMatrixRow {
  command?: string;
  origin?: string;
}

/**
 * Look one conversation up in {@link RESUME_MATRIX}. The origin is checked first: a fan-out cell is
 * refused on every surface, and its command column cannot be trusted to say otherwise because it
 * names the mode the cell ran under.
 */
export function resumeMatrixVerdict(
  row: ResumeMatrixRow,
  surface: ResumeSurface
): ResumeMatrixVerdict {
  if (row.origin) return { ok: false, reason: 'fan-out', origin: row.origin, command: row.command };
  const command = row.command;
  if (!command || !(RESUMABLE_RECORDED_COMMANDS as readonly string[]).includes(command)) {
    return { ok: false, reason: 'unsupported-command', command };
  }
  const cell = RESUME_MATRIX[command as ResumableRecordedCommand][surface];
  return { ok: true, requireCleanTail: cell === 'resume-if-clean' };
}

/**
 * How a stored thread ends, read off its newest checkpoint.
 *
 * - `clean` — it can take another user message.
 * - `pending-tool-call` — its last assistant message asked for a tool call that has no result, or
 *   the checkpoint carries a pending interrupt write. Both are what a run leaves when it stopped at
 *   an approval nobody could answer.
 *
 * **Read off the checkpoint, not asked of the runner.** The runner's own pending-interrupt query
 * answered 0 for exactly this thread while the interrupt write was on disk (the same probe), because
 * it asks the graph for its tasks and a run that threw has none. The tuple is the ground truth.
 */
export type ThreadTail = 'clean' | 'pending-tool-call';

/** LangGraph's channel name for an interrupt, as it appears in a checkpoint's pending writes. */
const INTERRUPT_CHANNEL = '__interrupt__';

export function threadTail(tuple: CheckpointTuple): ThreadTail {
  if ((tuple.pendingWrites ?? []).some(([, channel]) => channel === INTERRUPT_CHANNEL)) {
    return 'pending-tool-call';
  }
  const raw = (tuple.checkpoint?.channel_values as Record<string, unknown> | undefined)?.messages;
  const messages = Array.isArray(raw) ? (raw as BaseMessage[]) : [];
  let lastAi = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (AIMessage.isInstance(messages[i])) {
      lastAi = i;
      break;
    }
  }
  if (lastAi === -1) return 'clean';
  const calls = (messages[lastAi] as AIMessage).tool_calls ?? [];
  if (calls.length === 0) return 'clean';
  const answered = new Set(
    messages
      .slice(lastAi + 1)
      .filter((m) => ToolMessage.isInstance(m))
      .map((m) => (m as ToolMessage).tool_call_id)
  );
  return calls.every((call) => call.id !== undefined && answered.has(call.id))
    ? 'clean'
    : 'pending-tool-call';
}
