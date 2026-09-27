/**
 * GS2-106 — the resume matrix and the thread-tail check, asked THROUGH the resume seam
 * (`resolveResumeTarget`), which is what every surface calls: every refused cell with its reason and
 * its sentence, an accepted cell per surface, the thread-tail refusal on the cells this node added
 * and not on GS2-20's own cell, grants restored only on the interactive surface, and the `/resume`
 * picker's filter.
 *
 * Real history store and real checkpointer over a temp file. Nothing resolves a path from `HOME`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { recordSessionTurnSafe } from '@gaunt-sloth/core/history/recordSession.js';
import { openSessionCheckpointerSafe } from '@gaunt-sloth/core/history/sessionCheckpointer.js';
import { saveConversationGrantsSafe } from '@gaunt-sloth/core/core/approvals/conversationGrants.js';
import type { ResumeSurface } from '@gaunt-sloth/core/history/resumeMatrix.js';
import {
  listResumeCandidates,
  resolveResumeTarget,
  resumeRefusalNotice,
  type ResumeRefusal,
} from '#src/modules/sessionResume.js';

const SURFACES: ResumeSurface[] = ['ask', 'exec', 'interactive', 'history'];
const WORKSPACE = '/work/here';

describe('GS2-106 — the resume matrix at the seam', () => {
  let dir: string;
  let config: { history: { dbPath: string } };
  const closers: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'gsloth-resume-matrix-'));
    config = { history: { dbPath: resolve(dir, 'history.db') } };
  });
  afterEach(() => {
    for (const close of closers.splice(0)) close();
    rmSync(dir, { recursive: true, force: true });
  });

  const durable = () => {
    const ckpt = openSessionCheckpointerSafe(config, { notify: () => {} });
    closers.push(() => ckpt.close());
    expect(ckpt.durable).toBe(true);
    return ckpt;
  };

  let threads = 0;
  /**
   * A recorded conversation as `runSingleShot` or a session leaves one: a row opened by the record,
   * with its thread, its origin when given, and a checkpoint holding `messages`. `interrupt` adds
   * the pending interrupt write an approval stop leaves behind.
   */
  const seed = async (
    saver: BaseCheckpointSaver,
    over: {
      command: string;
      origin?: string;
      messages?: BaseMessage[];
      interrupt?: boolean;
    }
  ): Promise<number> => {
    const threadId = `thread-${++threads}`;
    const recorded = recordSessionTurnSafe(config, {
      command: over.command,
      ...(over.origin ? { origin: over.origin } : {}),
      project: WORKSPACE,
      threadId,
      prompt: 'p',
      response: 'r',
    })!;
    const cp = await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      {
        v: 4,
        id: `cp-${threadId}`,
        ts: new Date().toISOString(),
        channel_values: { messages: over.messages ?? [new HumanMessage('p'), new AIMessage('r')] },
        channel_versions: {},
        versions_seen: {},
      },
      { source: 'loop', step: 1, parents: {} },
      {}
    );
    if (over.interrupt) {
      await saver.putWrites(cp, [['__interrupt__', { value: 'approval needed' }]], 'task-1');
    }
    return recorded.conversationId;
  };

  const resolveOn = async (ckpt: ReturnType<typeof durable>, id: number, surface: ResumeSurface) =>
    resolveResumeTarget({ config, checkpointer: ckpt, workspace: WORKSPACE }, id, surface);

  const refusalOf = (result: Awaited<ReturnType<typeof resolveOn>>): ResumeRefusal => {
    expect(result.ok, 'refused').toBe(false);
    return (result as { refusal: ResumeRefusal }).refusal;
  };

  it('a fan-out cell is refused on every surface, loudly, naming its origin and gth history show', async () => {
    const ckpt = durable();
    for (const origin of ['batch', 'eval', 'gth-batch', 'workflow']) {
      const id = await seed(ckpt.saver, { command: origin === 'eval' ? 'ask' : 'exec', origin });
      for (const surface of SURFACES) {
        const refusal = refusalOf(await resolveOn(ckpt, id, surface));
        expect(refusal, `${origin} → ${surface}`).toMatchObject({
          kind: 'not-resumable',
          id,
          reason: 'fan-out',
          origin,
        });
        const notice = resumeRefusalNotice(refusal);
        expect(notice.title).toBe(`Conversation #${id} cannot be resumed`);
        expect(notice.lines[0]).toContain(`\`gth ${origin}\``);
        expect(notice.lines[0]).toContain('not supported');
        expect(notice.lines.join(' ')).toContain(`gth history show ${id}`);
        expect(notice.tone).toBe('warn');
      }
    }
  });

  it('a conversation recorded by a command with no row is refused on every surface', async () => {
    const ckpt = durable();
    for (const command of ['review', 'pr']) {
      const id = await seed(ckpt.saver, { command });
      for (const surface of SURFACES) {
        const refusal = refusalOf(await resolveOn(ckpt, id, surface));
        expect(refusal, `${command} → ${surface}`).toMatchObject({
          reason: 'unsupported-command',
          command,
        });
        expect(resumeRefusalNotice(refusal).lines[0]).toContain(`\`gth ${command}\``);
      }
    }
  });

  it('an ask row resumes on every surface, and a chat row resumes into exec now that grants stay behind', async () => {
    const ckpt = durable();
    const ask = await seed(ckpt.saver, { command: 'ask' });
    for (const surface of SURFACES) {
      const result = await resolveOn(ckpt, ask, surface);
      expect(result.ok, `ask → ${surface}`).toBe(true);
    }
    const chat = await seed(ckpt.saver, { command: 'chat' });
    const intoExec = await resolveOn(ckpt, chat, 'exec');
    expect(intoExec.ok).toBe(true);
    expect((intoExec as { target: { conversationId: number } }).target.conversationId).toBe(chat);
  });

  it('REVISION 2 grants: the store’s grants come back on the interactive surface only', async () => {
    const ckpt = durable();
    const chat = await seed(ckpt.saver, { command: 'chat' });
    saveConversationGrantsSafe(config, chat, {
      allow: [
        {
          entry: { type: 'shell', matcher: 'exact', pattern: 'git push' },
          grantedAt: '2026-09-01T10:00:00.000Z',
          scope: 'session',
        },
      ],
      deny: [],
    });
    const interactive = await resolveOn(ckpt, chat, 'interactive');
    expect(
      (
        interactive as { target: { grants: { allow: { entry: unknown }[] } } }
      ).target.grants.allow.map((g) => g.entry)
    ).toEqual([{ type: 'shell', matcher: 'exact', pattern: 'git push' }]);
    for (const surface of ['ask', 'exec', 'history'] as const) {
      const result = await resolveOn(ckpt, chat, surface);
      expect((result as { target: { grants: unknown } }).target.grants, surface).toEqual({
        allow: [],
        deny: [],
      });
    }
  });

  describe('a thread ending on an unanswered tool call', () => {
    const unanswered = (): BaseMessage[] => [
      new HumanMessage('run it'),
      new AIMessage({
        content: '',
        tool_calls: [{ name: 'run_shell_command', args: { command: 'x' }, id: 'call-1' }],
      }),
    ];

    it('is refused on every surface for an ask or exec row, with its own sentence', async () => {
      const ckpt = durable();
      for (const command of ['ask', 'exec']) {
        const id = await seed(ckpt.saver, { command, messages: unanswered() });
        for (const surface of SURFACES) {
          const refusal = refusalOf(await resolveOn(ckpt, id, surface));
          expect(refusal, `${command} → ${surface}`).toMatchObject({
            reason: 'pending-tool-call',
            command,
          });
          const notice = resumeRefusalNotice(refusal);
          expect(notice.lines[0]).toContain('approval stop');
          expect(notice.lines.join(' ')).toContain(`gth history show ${id}`);
        }
      }
    });

    it('is refused by the pending interrupt write alone, when the messages look clean', async () => {
      const ckpt = durable();
      const id = await seed(ckpt.saver, { command: 'exec', interrupt: true });
      expect(refusalOf(await resolveOn(ckpt, id, 'exec'))).toMatchObject({
        reason: 'pending-tool-call',
      });
      // CONTROL — the same row shape without the write resumes.
      const clean = await seed(ckpt.saver, { command: 'exec' });
      expect((await resolveOn(ckpt, clean, 'exec')).ok).toBe(true);
    });

    it('CONTROL: a thread whose tool call was answered resumes', async () => {
      const ckpt = durable();
      const id = await seed(ckpt.saver, {
        command: 'ask',
        messages: [
          ...unanswered(),
          new ToolMessage({ content: 'done', tool_call_id: 'call-1' }),
          new AIMessage('finished'),
        ],
      });
      for (const surface of SURFACES) {
        expect((await resolveOn(ckpt, id, surface)).ok, surface).toBe(true);
      }
    });

    it('a chat row is refused on the new cells (ask, exec) and left alone on its GS2-20 cell', async () => {
      const ckpt = durable();
      const id = await seed(ckpt.saver, { command: 'chat', messages: unanswered() });
      expect(refusalOf(await resolveOn(ckpt, id, 'ask'))).toMatchObject({
        reason: 'pending-tool-call',
      });
      expect(refusalOf(await resolveOn(ckpt, id, 'exec'))).toMatchObject({
        reason: 'pending-tool-call',
      });
      expect((await resolveOn(ckpt, id, 'interactive')).ok).toBe(true);
      expect((await resolveOn(ckpt, id, 'history')).ok).toBe(true);
    });
  });

  it('the /resume picker offers ask and exec rows, and never a fan-out cell or a review row', async () => {
    const ckpt = durable();
    const ask = await seed(ckpt.saver, { command: 'ask' });
    const exec = await seed(ckpt.saver, { command: 'exec' });
    const chat = await seed(ckpt.saver, { command: 'chat' });
    const cell = await seed(ckpt.saver, { command: 'exec', origin: 'batch' });
    const review = await seed(ckpt.saver, { command: 'review' });
    const offered = listResumeCandidates(config, undefined).map((c) => c.id);
    expect(offered).toEqual(expect.arrayContaining([ask, exec, chat]));
    expect(offered).not.toContain(cell);
    expect(offered).not.toContain(review);
  });
});
