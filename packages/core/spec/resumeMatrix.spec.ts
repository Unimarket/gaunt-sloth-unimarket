/**
 * GS2-106 — the resume matrix and the thread-tail check, as pure functions. The same table is
 * exercised through the resume seam in `packages/agent/spec/resumeMatrixSeam.spec.ts`; this file
 * pins the table itself, cell by cell, so a changed cell is a red here before it is anywhere else.
 */
import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { CheckpointTuple } from '@langchain/langgraph';

const tuple = (
  messages: unknown[],
  pendingWrites: CheckpointTuple['pendingWrites'] = []
): CheckpointTuple =>
  ({
    config: { configurable: { thread_id: 't' } },
    checkpoint: {
      v: 4,
      id: 'cp',
      ts: '',
      channel_values: { messages },
      channel_versions: {},
      versions_seen: {},
    },
    pendingWrites,
  }) as unknown as CheckpointTuple;

describe('GS2-106 — resumeMatrixVerdict', () => {
  const surfaces = ['ask', 'exec', 'interactive', 'history'] as const;

  it('every recorded ask/exec/chat/code row resumes on every surface', async () => {
    const { resumeMatrixVerdict } = await import('#src/history/resumeMatrix.js');
    for (const command of ['ask', 'exec', 'chat', 'code']) {
      for (const surface of surfaces) {
        expect(resumeMatrixVerdict({ command }, surface).ok, `${command} → ${surface}`).toBe(true);
      }
    }
  });

  it('only the GS2-20 cell skips the thread-tail check: chat/code resumed interactively or by history', async () => {
    const { resumeMatrixVerdict } = await import('#src/history/resumeMatrix.js');
    const clean = (command: string, surface: (typeof surfaces)[number]) => {
      const v = resumeMatrixVerdict({ command }, surface);
      return v.ok ? v.requireCleanTail : 'refused';
    };
    expect(clean('chat', 'interactive')).toBe(false);
    expect(clean('code', 'interactive')).toBe(false);
    expect(clean('chat', 'history')).toBe(false);
    expect(clean('code', 'history')).toBe(false);
    expect(clean('chat', 'ask')).toBe(true);
    expect(clean('code', 'exec')).toBe(true);
    for (const surface of surfaces) {
      expect(clean('ask', surface), `ask → ${surface}`).toBe(true);
      expect(clean('exec', surface), `exec → ${surface}`).toBe(true);
    }
  });

  it('a row with an origin is refused on every surface as a fan-out cell, whatever its command', async () => {
    const { resumeMatrixVerdict } = await import('#src/history/resumeMatrix.js');
    for (const origin of ['batch', 'eval', 'gth-batch', 'workflow']) {
      for (const surface of surfaces) {
        expect(resumeMatrixVerdict({ command: 'exec', origin }, surface)).toEqual({
          ok: false,
          reason: 'fan-out',
          origin,
          command: 'exec',
        });
      }
    }
  });

  it('a command with no row is refused on every surface, and so is a row with no command', async () => {
    const { resumeMatrixVerdict } = await import('#src/history/resumeMatrix.js');
    for (const command of ['review', 'pr', undefined]) {
      for (const surface of surfaces) {
        expect(resumeMatrixVerdict({ command }, surface)).toEqual({
          ok: false,
          reason: 'unsupported-command',
          command,
        });
      }
    }
  });

  it('the subcommands --resume rides along with are ask, exec, chat and code', async () => {
    const { RESUME_SURFACE_OF_SUBCOMMAND } = await import('#src/history/resumeMatrix.js');
    expect(RESUME_SURFACE_OF_SUBCOMMAND).toEqual({
      ask: 'ask',
      exec: 'exec',
      chat: 'interactive',
      code: 'interactive',
    });
  });
});

describe('GS2-106 — threadTail', () => {
  const call = (id: string) => ({ name: 'lookup', args: {}, id });

  it('a thread ending on an answer, or with every tool call answered, is clean', async () => {
    const { threadTail } = await import('#src/history/resumeMatrix.js');
    expect(threadTail(tuple([]))).toBe('clean');
    expect(threadTail(tuple([new HumanMessage('q'), new AIMessage('a')]))).toBe('clean');
    expect(
      threadTail(
        tuple([
          new HumanMessage('q'),
          new AIMessage({ content: '', tool_calls: [call('c1')] }),
          new ToolMessage({ content: 'r', tool_call_id: 'c1' }),
        ])
      )
    ).toBe('clean');
  });

  it('a thread ending on an assistant tool call with no result is not', async () => {
    const { threadTail } = await import('#src/history/resumeMatrix.js');
    expect(
      threadTail(
        tuple([new HumanMessage('q'), new AIMessage({ content: '', tool_calls: [call('c1')] })])
      )
    ).toBe('pending-tool-call');
  });

  it('nor is one where only some of the last turn’s parallel tool calls were answered', async () => {
    const { threadTail } = await import('#src/history/resumeMatrix.js');
    expect(
      threadTail(
        tuple([
          new HumanMessage('q'),
          new AIMessage({ content: '', tool_calls: [call('c1'), call('c2')] }),
          new ToolMessage({ content: 'r', tool_call_id: 'c1' }),
        ])
      )
    ).toBe('pending-tool-call');
  });

  it('nor is one carrying a pending interrupt write, even when its messages end cleanly', async () => {
    const { threadTail } = await import('#src/history/resumeMatrix.js');
    const messages = [new HumanMessage('q'), new AIMessage('a')];
    expect(threadTail(tuple(messages))).toBe('clean');
    expect(threadTail(tuple(messages, [['task-1', '__interrupt__', { value: 'x' }]]))).toBe(
      'pending-tool-call'
    );
    // A pending write on any other channel is not an interrupt.
    expect(threadTail(tuple(messages, [['task-1', 'messages', []]]))).toBe('clean');
  });
});
