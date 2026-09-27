/**
 * GS2-106 — the continue hint: after a recorded `gth ask` or `gth exec` run, one line on stderr
 * naming the command that continues the conversation, e.g. `gth ask --resume <run id> "…"`.
 *
 * ## The gate, and why each condition is in it
 *
 * The hint is a promise that pasting it works. So it is printed only when every condition a
 * resume would check already holds, and the checks are the resume seam's own, not a copy:
 *
 * - **The caller asked for it** (`SingleShotOptions.announceResumeHint`). `runSingleShot` has five
 *   callers; `ask` and `exec` are a person reading what came back, while `batch`, `eval`,
 *   `gth-batch` and `workflow` are harnesses whose cells every resume surface refuses anyway. A
 *   default-on hint would print a command that fails, hundreds of times per run.
 * - **The run was recorded.** History off, or a store that would not take the row, leaves nothing
 *   to resume.
 * - **The thread is durable and its link was not cut.** A store that did not open ran the turn in
 *   memory; a checkpoint write that failed mid-run cut the conversation's link to its thread. Either
 *   way the row exists and the resume seam refuses it.
 * - **The thread has a checkpoint and ends cleanly** ({@link threadTail}). A run that stopped at an
 *   approval, with a tool call nobody answered, is exactly what `ask`/`exec --resume` refuse; the
 *   same predicate decides both, so the hint cannot offer what the seam will turn down.
 *
 * ## What it names
 *
 * The run id, never the integer: the integer is only meaningful in this one database, and a
 * recreated database hands the same integers out again. A row written before run ids existed has
 * none, and one is never minted at resume time, so its hint falls back to the integer and `debug`
 * says why. The verb is the one just run — `ask` or `exec` — because that is the one the person
 * already knows the arguments of.
 *
 * ## Rungs
 *
 * `output.resumeHint`, on the `output.header` rungs, defaulted HERE (at the read site) to
 * `compact`: `none` prints nothing, `compact` the one line, `debug` the line plus the integer id and
 * the history file — and, when there is no hint, the reason there is none.
 *
 * On stderr (`displayNotice`), so `gth ask … > answer.txt` keeps only the answer.
 */
import type { GthConfig } from '#src/config.js';
import type { GthOutputHeaderRung } from '#src/config/schema.js';
import type { GthCommand } from '#src/core/types.js';
import { isHistoryEnabled } from '#src/history/historyEnabled.js';
import { resolveHistoryDbPath } from '#src/history/historyStore.js';
import { threadTail } from '#src/history/resumeMatrix.js';
import type { SessionCheckpointer } from '#src/history/sessionCheckpointer.js';
import { displayNotice } from '#src/utils/consoleUtils.js';

/** Whether a finished run can be continued, and if not, why — the fact behind the hint. */
export type SingleShotResumability =
  | { resumable: true }
  | {
      resumable: false;
      reason:
        | 'history-off'
        | 'not-recorded'
        | 'store-unavailable'
        | 'link-cut'
        | 'no-checkpoint'
        | 'pending-tool-call';
    };

/** The rung in force. An unset key is `compact`: the hint is shown by default. */
export function resolveResumeHintRung(config: Pick<GthConfig, 'output'>): GthOutputHeaderRung {
  return config.output?.resumeHint ?? 'compact';
}

/**
 * Decide whether the run just recorded can be resumed, reading the thread's latest checkpoint.
 * Called after the record and before the checkpointer closes. Never throws: a checkpoint that
 * cannot be read counts as no checkpoint, because the hint must never be what breaks a run.
 */
export async function resumabilityOf(
  config: GthConfig,
  checkpointer: SessionCheckpointer,
  recorded: { conversationId: number } | undefined
): Promise<SingleShotResumability> {
  if (!isHistoryEnabled(config)) return { resumable: false, reason: 'history-off' };
  if (!recorded) return { resumable: false, reason: 'not-recorded' };
  if (!checkpointer.durable) return { resumable: false, reason: 'store-unavailable' };
  if (checkpointer.isDegraded?.()) return { resumable: false, reason: 'link-cut' };
  try {
    const tuple = await checkpointer.saver.getTuple({
      configurable: { thread_id: checkpointer.threadId, checkpoint_ns: '' },
    });
    if (!tuple) return { resumable: false, reason: 'no-checkpoint' };
    if (threadTail(tuple) !== 'clean') return { resumable: false, reason: 'pending-tool-call' };
  } catch {
    return { resumable: false, reason: 'no-checkpoint' };
  }
  return { resumable: true };
}

const NO_HINT_REASON: Record<
  Exclude<SingleShotResumability, { resumable: true }>['reason'],
  string
> = {
  'history-off': 'history is off (history.enabled: false), so this run was not recorded.',
  'not-recorded': 'this run could not be recorded in the history store.',
  'store-unavailable':
    'the conversation store did not open, so this run was not checkpointed and cannot be ' +
    'continued.',
  'link-cut':
    'a checkpoint write failed during the run, so the conversation lost its link to its saved ' +
    'state and cannot be continued.',
  'no-checkpoint': 'no checkpoint was saved for this run, so there is nothing to continue from.',
  'pending-tool-call':
    'the run stopped at a tool call that was never answered, so there is no finished turn to ' +
    'continue from.',
};

/** The command that continues the conversation, exactly as it must be typed. */
export function resumeHintCommand(command: 'ask' | 'exec', id: string | number): string {
  return command === 'exec' ? `gth exec --resume ${id} -m "…"` : `gth ask --resume ${id} "…"`;
}

/**
 * Print the hint — or, under `debug`, the reason there is none. Only `ask` and `exec` have a
 * command to name; any other caller prints nothing whatever the rung.
 */
export function announceResumeHint(
  config: GthConfig,
  command: GthCommand,
  recorded: { conversationId: number; runId: string | null } | undefined,
  resumability: SingleShotResumability
): void {
  const rung = resolveResumeHintRung(config);
  if (rung === 'none' || (command !== 'ask' && command !== 'exec')) return;
  const debug = rung === 'debug';
  const where = () => `History file: ${resolveHistoryDbPath(config.history?.dbPath)}`;

  if (!resumability.resumable) {
    if (!debug) return;
    const lines = recorded ? [`Conversation #${recorded.conversationId}.`, where()] : [];
    displayNotice(`No resume hint: ${NO_HINT_REASON[resumability.reason]}`, lines);
    return;
  }

  const id = recorded!.runId ?? recorded!.conversationId;
  const title = `To continue this conversation: ${resumeHintCommand(command, id)}`;
  if (!debug) {
    displayNotice(title, []);
    return;
  }
  const lines = [`Conversation #${recorded!.conversationId}.`, where()];
  if (recorded!.runId === null) {
    lines.push(
      'This conversation predates run ids, so it is named by its number, which is only valid in ' +
        'this history file.'
    );
  }
  displayNotice(title, lines);
}
