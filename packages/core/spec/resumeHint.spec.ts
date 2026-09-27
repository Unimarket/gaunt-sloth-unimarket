/**
 * GS2-106 — the continue hint's gate, cell by cell, over a stub checkpointer: the conditions a real
 * run reaches only through an approval stop or a store failure are set up directly here. The real
 * round trip, the rungs and the degrade path run on a real agent in `singleShotResume.spec.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';
import type { GthConfig } from '#src/config.js';
import type { SessionCheckpointer } from '#src/history/sessionCheckpointer.js';
import * as consoleUtils from '#src/utils/consoleUtils.js';

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/utils/consoleUtils.js')>()),
  displayNotice: vi.fn(),
}));

const { announceResumeHint, resumabilityOf } = await import('#src/runtime/resumeHint.js');
const { rawGthConfigSchema } = await import('#src/config/schema.js');

const config = (over: Record<string, unknown> = {}) =>
  ({ history: { dbPath: '/tmp/hint-spec/history.db' }, ...over }) as unknown as GthConfig;

const tupleOf = (
  messages: unknown[],
  pendingWrites: CheckpointTuple['pendingWrites'] = []
): CheckpointTuple =>
  ({
    config: {},
    checkpoint: { channel_values: { messages } },
    pendingWrites,
  }) as unknown as CheckpointTuple;

const checkpointer = (
  over: Partial<SessionCheckpointer> & { tuple?: CheckpointTuple | undefined | Error } = {}
): SessionCheckpointer => {
  const { tuple, ...rest } = over;
  return {
    durable: true,
    threadId: 't-1',
    isDegraded: () => false,
    saver: {
      getTuple: async () => {
        if (tuple instanceof Error) throw tuple;
        return tuple;
      },
    },
    close: () => {},
    ...rest,
  } as unknown as SessionCheckpointer;
};

const RECORDED = { conversationId: 7, runId: '11111111-2222-4333-8444-555555555555' };
const CLEAN = tupleOf([new HumanMessage('q'), new AIMessage('a')]);

describe('resumabilityOf — the hint gate', () => {
  it('a recorded, durable, linked thread whose last turn finished is resumable', async () => {
    expect(await resumabilityOf(config(), checkpointer({ tuple: CLEAN }), RECORDED)).toEqual({
      resumable: true,
    });
  });

  it('a finished tool round trip is clean', async () => {
    const tuple = tupleOf([
      new HumanMessage('q'),
      new AIMessage({ content: '', tool_calls: [{ name: 'x', args: {}, id: 'c1' }] }),
      new ToolMessage({ content: 'r', tool_call_id: 'c1' }),
      new AIMessage('done'),
    ]);
    expect(await resumabilityOf(config(), checkpointer({ tuple }), RECORDED)).toEqual({
      resumable: true,
    });
  });

  const cells: Array<[string, Parameters<typeof resumabilityOf>, string]> = [
    [
      'history off',
      [config({ history: { enabled: false } }), checkpointer({ tuple: CLEAN }), undefined],
      'history-off',
    ],
    ['not recorded', [config(), checkpointer({ tuple: CLEAN }), undefined], 'not-recorded'],
    [
      'the store did not open',
      [config(), checkpointer({ tuple: CLEAN, durable: false }), RECORDED],
      'store-unavailable',
    ],
    [
      'the link was cut by a failed write',
      [config(), checkpointer({ tuple: CLEAN, isDegraded: () => true }), RECORDED],
      'link-cut',
    ],
    ['no checkpoint', [config(), checkpointer({ tuple: undefined }), RECORDED], 'no-checkpoint'],
    [
      'a checkpoint that cannot be read',
      [config(), checkpointer({ tuple: new Error('disk') }), RECORDED],
      'no-checkpoint',
    ],
    [
      'the last turn stopped at an unanswered tool call',
      [
        config(),
        checkpointer({
          tuple: tupleOf([
            new HumanMessage('q'),
            new AIMessage({ content: '', tool_calls: [{ name: 'x', args: {}, id: 'c1' }] }),
          ]),
        }),
        RECORDED,
      ],
      'pending-tool-call',
    ],
    [
      'an interrupt write is pending',
      [
        config(),
        checkpointer({ tuple: tupleOf([new HumanMessage('q')], [['task', '__interrupt__', {}]]) }),
        RECORDED,
      ],
      'pending-tool-call',
    ],
  ];
  for (const [name, args, reason] of cells) {
    it(`${name}: not resumable, reason ${reason}`, async () => {
      expect(await resumabilityOf(...args)).toEqual({ resumable: false, reason });
    });
  }
});

describe('announceResumeHint', () => {
  it('prints nothing for a command other than ask or exec, whatever the rung', () => {
    vi.mocked(consoleUtils.displayNotice).mockClear();
    announceResumeHint(config({ output: { resumeHint: 'debug' } }), 'code', RECORDED, {
      resumable: true,
    });
    announceResumeHint(config({ output: { resumeHint: 'debug' } }), 'review', RECORDED, {
      resumable: false,
      reason: 'link-cut',
    });
    expect(consoleUtils.displayNotice).not.toHaveBeenCalled();
  });

  it('under compact a run with no hint says nothing at all', () => {
    vi.mocked(consoleUtils.displayNotice).mockClear();
    announceResumeHint(config(), 'ask', RECORDED, {
      resumable: false,
      reason: 'pending-tool-call',
    });
    expect(consoleUtils.displayNotice).not.toHaveBeenCalled();
  });

  it('under debug a pending tool call is named as the reason', () => {
    vi.mocked(consoleUtils.displayNotice).mockClear();
    announceResumeHint(config({ output: { resumeHint: 'debug' } }), 'exec', RECORDED, {
      resumable: false,
      reason: 'pending-tool-call',
    });
    const [[title, lines]] = vi.mocked(consoleUtils.displayNotice).mock.calls;
    expect(title).toContain('the run stopped at a tool call that was never answered');
    expect(lines).toEqual(['Conversation #7.', 'History file: /tmp/hint-spec/history.db']);
  });
});

describe('output.resumeHint in the schema', () => {
  it('accepts the three header rungs and nothing else, naming the rung a boolean meant', () => {
    for (const rung of ['none', 'compact', 'debug']) {
      expect(rawGthConfigSchema.safeParse({ output: { resumeHint: rung } }).success, rung).toBe(
        true
      );
    }
    const bad = rawGthConfigSchema.safeParse({ output: { resumeHint: 'loud' } });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0].message).toContain('is not a resume-hint rung');
    const bool = rawGthConfigSchema.safeParse({ output: { resumeHint: false } });
    expect(bool.error!.issues[0].message).toContain('Use "none" instead of false');
  });
});
