import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCheckpointStoreStats,
  formatConversationList,
  formatConversationThread,
  formatInsightsSummary,
  formatSearchResults,
  formatStoreSizeLine,
} from '#src/history/historyFormat.js';
import type { CheckpointStoreStats } from '#src/history/checkpointRetention.js';
import type {
  ConversationSummary,
  HistoryInsights,
  SessionRecord,
  SessionSearchResult,
} from '#src/history/historyStore.js';

const hit = (over: Partial<SessionSearchResult> = {}): SessionSearchResult => ({
  id: 1,
  ts: '2026-07-03T10:00:00.000Z',
  command: 'ask',
  model: 'gpt-5',
  prompt: 'How do I do the thing?',
  response: 'Like this.',
  snippet: 'do the [thing]',
  ...over,
});

describe('history/historyFormat', () => {
  describe('formatSearchResults', () => {
    it('renders a header + snippet per hit', () => {
      const lines = formatSearchResults([hit()]);
      expect(lines[0]).toContain('#1');
      expect(lines[0]).toContain('[ask]');
      expect(lines[0]).toContain('gpt-5');
      expect(lines[1].trim()).toBe('do the [thing]');
    });
    it('falls back to a prompt preview when the snippet is empty', () => {
      const lines = formatSearchResults([hit({ snippet: '' })]);
      expect(lines[1].trim()).toBe('How do I do the thing?');
    });
    it('reports a friendly line when there are no hits', () => {
      expect(formatSearchResults([])).toEqual(['No matching sessions found.']);
    });
  });

  describe('formatConversationList (GS2-19)', () => {
    const conv = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
      id: 5,
      startedTs: '2026-07-03T10:00:00.000Z',
      command: 'chat',
      model: 'gpt-5',
      turnCount: 3,
      firstTs: '2026-07-03T10:00:00.000Z',
      lastTs: '2026-07-03T10:05:00.000Z',
      lastPrompt: 'the last thing I asked',
      lastResponse: 'the last answer',
      ...over,
    });

    it('renders a conversation-grained header: id, timespan, command, model, turn count', () => {
      const lines = formatConversationList([conv()]);
      expect(lines[0]).toContain('#5');
      expect(lines[0]).toContain('[chat]');
      expect(lines[0]).toContain('gpt-5');
      expect(lines[0]).toContain('→'); // timespan first → last
      expect(lines[0]).toContain('(3 turns)');
      expect(lines[1].trim()).toBe('the last thing I asked'); // last-message preview
    });

    it('singularises one turn and collapses a same-instant timespan to a single timestamp', () => {
      const lines = formatConversationList([
        conv({ turnCount: 1, firstTs: 'T', lastTs: 'T', lastPrompt: 'only' }),
      ]);
      expect(lines[0]).toContain('(1 turn)');
      expect(lines[0]).not.toContain('→');
    });

    // GS2-106 — a fan-out cell names the run that made it beside its mode; a direct run does not.
    it('shows a fan-out cell’s origin beside its command', () => {
      const [cell] = formatConversationList([conv({ command: 'exec', origin: 'batch' })]);
      expect(cell).toContain('[exec, batch cell]');
      const [direct] = formatConversationList([conv({ command: 'exec' })]);
      expect(direct).toContain('[exec]');
    });

    it('reports an enable hint when there are no conversations', () => {
      expect(formatConversationList([])[0]).toContain('history.enabled');
    });
  });

  describe('formatConversationThread (GS2-19)', () => {
    it('renders every turn in order with prompt + response previews', () => {
      const turns: SessionRecord[] = [
        { ts: '2026-07-03T10:00:00.000Z', prompt: 'first q', response: 'first a' },
        { ts: '2026-07-03T10:01:00.000Z', prompt: 'second q', response: 'second a' },
      ];
      const lines = formatConversationThread(turns);
      expect(lines.some((l) => l.startsWith('Turn 1'))).toBe(true);
      expect(lines.some((l) => l.startsWith('Turn 2'))).toBe(true);
      expect(lines.some((l) => l.includes('first q'))).toBe(true);
      expect(lines.some((l) => l.includes('second a'))).toBe(true);
      // Order preserved: Turn 1 appears before Turn 2.
      expect(lines.findIndex((l) => l.startsWith('Turn 1'))).toBeLessThan(
        lines.findIndex((l) => l.startsWith('Turn 2'))
      );
    });

    it('reports a friendly line for an unknown / empty conversation', () => {
      expect(formatConversationThread([])).toEqual(['No turns found for that conversation.']);
    });
  });

  describe('formatInsightsSummary', () => {
    const insights: HistoryInsights = {
      sessionCount: 3,
      totalTokensInput: 300,
      totalTokensOutput: 130,
      totalTokens: 430,
      totalCostUsd: 0.03,
      topTools: [{ tool: 'read_file', count: 3 }],
      perCommand: [{ command: 'ask', count: 2 }],
      firstTs: '2026-07-01T00:00:00.000Z',
      lastTs: '2026-07-03T00:00:00.000Z',
    };
    it('renders totals, per-command and top tools', () => {
      const lines = formatInsightsSummary(insights);
      expect(lines.some((l) => l.includes('Sessions: 3'))).toBe(true);
      expect(lines.some((l) => l.includes('430 total'))).toBe(true);
      expect(lines.some((l) => l.includes('$0.0300'))).toBe(true);
      expect(lines.some((l) => l.includes('read_file: 3'))).toBe(true);
      expect(lines.some((l) => l.includes('ask: 2'))).toBe(true);
    });
    it('OMITS token, cost and top-tool lines when there is no such data (GS2-16)', () => {
      // Sessions were recorded (older records / providers that report no usage), but no tokens,
      // no cost and no tools — the misleading `0`/`$0.0000`/`(none recorded)` lines must not show.
      const noAnalytics: HistoryInsights = {
        sessionCount: 4,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        topTools: [],
        perCommand: [{ command: 'ask', count: 4 }],
        firstTs: '2026-07-01T00:00:00.000Z',
        lastTs: '2026-07-03T00:00:00.000Z',
      };
      const lines = formatInsightsSummary(noAnalytics);
      expect(lines.some((l) => l.includes('Sessions: 4'))).toBe(true); // always shown
      expect(lines.some((l) => l.includes('By command'))).toBe(true); // always shown
      expect(lines.some((l) => l.includes('Tokens'))).toBe(false);
      expect(lines.some((l) => l.toLowerCase().includes('cost'))).toBe(false);
      expect(lines.some((l) => l.includes('$'))).toBe(false);
      expect(lines.some((l) => l.toLowerCase().includes('tools'))).toBe(false);
    });

    it('SHOWS the token line when tokens exist but still omits cost when zero (GS2-16)', () => {
      const tokensNoCost: HistoryInsights = {
        sessionCount: 1,
        totalTokensInput: 100,
        totalTokensOutput: 30,
        totalTokens: 130,
        totalCostUsd: 0, // no reliable price → recorder never set costUsd
        topTools: [],
        perCommand: [],
      };
      const lines = formatInsightsSummary(tokensNoCost);
      expect(lines.some((l) => l.includes('130 total'))).toBe(true);
      expect(lines.some((l) => l.includes('$'))).toBe(false); // cost still suppressed
    });

    it('reports an enable hint for an empty store', () => {
      const empty: HistoryInsights = {
        sessionCount: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        topTools: [],
        perCommand: [],
      };
      expect(formatInsightsSummary(empty)[0]).toContain('history.enabled');
    });
  });

  describe('GS2-107 — the conversation-store readout', () => {
    const stats = (over: Partial<CheckpointStoreStats> = {}): CheckpointStoreStats => ({
      dbPath: '/home/somebody/.gsloth/history.db',
      fileBytes: 5 * 1024 * 1024,
      checkpointBytes: 3 * 1024 * 1024,
      checkpointCount: 124,
      writeCount: 300,
      threadCount: 10,
      largestThreads: [
        {
          threadId: 't-a',
          conversationId: 7,
          command: 'code',
          checkpointCount: 22,
          bytes: 900_000,
        },
        { threadId: 't-b', checkpointCount: 5, bytes: 1000 },
      ],
      unresumableThreadCount: 3,
      unresumableBytes: 4096,
      writeOnlyThreadCount: 0,
      writeOnlyBytes: 0,
      ...over,
    });

    it('reads bytes in units a person can act on', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(999)).toBe('999 B');
      expect(formatBytes(1024)).toBe('1.0 KB');
      expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
      // A negative or non-finite count is a bug upstream, not a number to render.
      expect(formatBytes(Number.NaN)).toBe('0 B');
    });

    it('keeps the file size and the checkpoint share as SEPARATE numbers', () => {
      // The same file holds the transcripts and the FTS index. One figure labelled as checkpoints
      // would overstate them on the very screen this exists to make honest.
      const line = formatStoreSizeLine(stats());
      expect(line).toContain('5.0 MB on disk');
      expect(line).toContain('3.0 MB is conversation state');
      expect(line).toContain('124 checkpoints across 10 threads');
      expect(line).toContain('gth history prune');
    });

    /**
     * GS2-111 — the byte figure covers the checkpoint tables whole, pending writes included, while
     * the count beside it is checkpoint rows alone. Handing one to the other is the false
     * attribution this node exists to remove: those 124 checkpoints do not weigh 3.0 MB.
     */
    it('does NOT attribute the whole byte figure to the checkpoint count', () => {
      const line = formatStoreSizeLine(stats());
      expect(line).not.toContain('3.0 MB is 124 checkpoints');
      // The writes are named as their own population rather than folded into the checkpoints.
      expect(line).toContain('300 pending writes');
    });

    /**
     * The orphan clause has to be read off `writeOnlyBytes` / `writeOnlyThreadCount` and nothing
     * else. An assertion on the rendered sentence cannot show that on its own — it reds for any
     * wording change at all — so this moves ONLY the orphan fields and pins that only the orphan
     * clause moves with them.
     */
    it('names the orphaned share, and moves it independently of every other figure', () => {
      const none = formatStoreSizeLine(stats());
      const some = formatStoreSizeLine(stats({ writeOnlyThreadCount: 2, writeOnlyBytes: 50_000 }));
      expect(none).not.toContain('with no checkpoint');
      expect(some).toContain('48.8 KB of that on 2 threads with no checkpoint');
      // The differential: that clause is the ONLY difference between the two renderings, so the
      // file size, the checkpoint share and both counts demonstrably did not move with it.
      expect(some.replace(', 48.8 KB of that on 2 threads with no checkpoint', '')).toBe(none);
    });

    it('counts a single orphaned thread in the singular', () => {
      const line = formatStoreSizeLine(stats({ writeOnlyThreadCount: 1, writeOnlyBytes: 1024 }));
      expect(line).toContain('1.0 KB of that on 1 thread with no checkpoint');
    });

    /**
     * The store a dropped first `put` leaves: pending writes and no checkpoint anywhere.
     * `gth history list` renders this line for such a store (GS2-111 widened its guard to the pair
     * GS2-108 settled on for `gth insights`), so the sentence has to be true with every checkpoint
     * figure at zero — and must never emit `0 checkpoints across 0 threads`, the rendering this
     * node was originally filed over.
     */
    it('a store of nothing but pending writes reads true, with no zero-checkpoint clause', () => {
      const line = formatStoreSizeLine(
        stats({
          fileBytes: 50_000,
          checkpointBytes: 50_000,
          checkpointCount: 0,
          threadCount: 0,
          writeCount: 12,
          writeOnlyThreadCount: 1,
          writeOnlyBytes: 50_000,
        })
      );
      expect(line).toContain('48.8 KB is conversation state');
      expect(line).toContain('12 pending writes');
      expect(line).toContain('48.8 KB of that on 1 thread with no checkpoint');
      expect(line).not.toContain('0 checkpoints');
      expect(line).not.toContain('0 threads');
    });

    /**
     * An embedder reaches this function off the published barrel with no guard in front of it, so
     * a stats object with nothing in it has to render a sentence rather than a dangling colon.
     */
    it('drops the detail entirely rather than trailing a colon over nothing', () => {
      const line = formatStoreSizeLine(
        stats({ checkpointBytes: 0, checkpointCount: 0, threadCount: 0, writeCount: 0 })
      );
      expect(line).toContain('0 B is conversation state.');
      expect(line).not.toContain('conversation state:');
    });

    it('names the largest threads and says which of them nothing can resume', () => {
      const lines = formatCheckpointStoreStats(stats());
      expect(lines.some((l) => l.includes('conversation #7') && l.includes('[code]'))).toBe(true);
      expect(lines.some((l) => l.includes('no conversation (not resumable)'))).toBe(true);
      expect(lines.some((l) => l.includes('3 threads no conversation names'))).toBe(true);
    });

    it('says nothing about unresumable threads when there are none', () => {
      const lines = formatCheckpointStoreStats(stats({ unresumableThreadCount: 0 }));
      expect(lines.some((l) => l.includes('Unresumable'))).toBe(false);
    });

    it('an empty store explains which commands write checkpoints at all', () => {
      const lines = formatCheckpointStoreStats(stats({ checkpointCount: 0 }));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('chat');
      expect(lines[0]).toContain('code');
    });

    // GS2-108 — the bytes this screen exists to make honest include pending writes whose
    // checkpoint never landed, and nothing in the per-thread breakdown can account for them.
    it('names the write-only threads and points at the one command that removes them', () => {
      const lines = formatCheckpointStoreStats(
        stats({ writeOnlyThreadCount: 2, writeOnlyBytes: 50_000 })
      );
      const said = lines.join('\n');
      expect(said).toContain('2 threads holding pending writes with no checkpoint');
      expect(said).toContain('48.8 KB');
      expect(said).toContain('gth history prune');
    });

    it('says nothing about write-only threads when there are none', () => {
      expect(formatCheckpointStoreStats(stats()).some((l) => l.includes('Unreadable'))).toBe(false);
    });

    /**
     * A store can hold write-only threads and nothing else — the shape a dropped first `put`
     * leaves. Counting checkpoints alone would answer "no checkpoints recorded" while the byte
     * total is not zero, which is this screen stating the opposite of what it just measured.
     */
    it('does NOT call a store of nothing but write-only threads empty', () => {
      const lines = formatCheckpointStoreStats(
        stats({ checkpointCount: 0, writeOnlyThreadCount: 1, writeOnlyBytes: 50_000 })
      );
      const said = lines.join('\n');
      expect(said).not.toContain('no checkpoints recorded');
      expect(said).toContain('1 thread holding pending writes with no checkpoint');
      expect(said).toContain('48.8 KB');
    });
  });
});
