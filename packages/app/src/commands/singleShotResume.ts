import type { HistoryConfigView } from '@gaunt-sloth/core/history/historyEnabled.js';
import type { ConversationRef } from '@gaunt-sloth/core/history/conversationRef.js';
import type { ResumeSurface } from '@gaunt-sloth/core/history/resumeMatrix.js';
import type { SingleShotResume } from '@gaunt-sloth/core/runtime/singleShot.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
import { displayNotice } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

/** Where a single-shot resume was asked for: the verb's own `--resume`, or `gth history resume`. */
export type SingleShotResumeSurface = Extract<ResumeSurface, 'ask' | 'exec' | 'history'>;

/**
 * GS2-106 — resolve the conversation a non-interactive resume names, through the SAME seam every
 * interactive resume uses (`resolveResumeTarget`), and say the refusal when there is one.
 *
 * Runs before the run starts — before any report file, any runner, any model call — so a refused
 * resume costs the person the message and nothing else. The seam needs a checkpointer to look the
 * thread up in; this one is opened for the check and closed straight after without being bound to a
 * conversation, which keeps retention from running on it. The run then opens its own, on the
 * resolved thread.
 *
 * Returns the conversation to continue, or `null` when refused (the caller exits 1).
 */
export async function resolveSingleShotResume(
  config: HistoryConfigView,
  ref: ConversationRef | number,
  surface: SingleShotResumeSurface
): Promise<SingleShotResume | null> {
  const { resolveResumeTarget, resumeRefusalNotice } =
    await import('@gaunt-sloth/agent/modules/sessionResume.js');
  const checkpointer = openSessionCheckpointerSafe(config);
  try {
    const resolution = await resolveResumeTarget(
      { config, checkpointer, workspace: getProjectDir() },
      ref,
      surface
    );
    if (!resolution.ok) {
      const notice = resumeRefusalNotice(resolution.refusal);
      displayNotice(notice.title, [...notice.lines, 'Nothing was run.'], {
        tone: notice.tone ?? 'warn',
      });
      return null;
    }
    return {
      conversationId: resolution.target.conversationId,
      threadId: resolution.target.threadId,
    };
  } finally {
    checkpointer.close();
  }
}
