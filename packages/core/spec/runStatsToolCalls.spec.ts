import { describe, expect, it } from 'vitest';
import { AIMessage, AIMessageChunk, ToolMessage } from '@langchain/core/messages';
import {
  accumulateMessage,
  createRunStatsAccumulator,
  extractRunStats,
  finalizeRunStats,
} from '#src/core/runStats.js';

/**
 * BATCH-52 — the run-stats accumulator records each requested tool call WITH its arguments, so
 * `gth eval` can grade `tool_call_json_path`. Two shapes reach it: a whole assistant message (the
 * non-streaming path) whose `tool_calls` carry parsed arguments, and streamed chunks whose
 * `tool_call_chunks` carry argument fragments that must be reassembled per call.
 */

function chunk(
  deltas: Array<{ index?: number; id?: string; name?: string; args?: string }>
): AIMessageChunk {
  return new AIMessageChunk({
    content: '',
    tool_call_chunks: deltas.map((d) => ({ type: 'tool_call_chunk' as const, ...d })),
  });
}

function result(id: string, name: string): ToolMessage {
  return new ToolMessage({ content: 'ok', tool_call_id: id, name });
}

describe('core/runStats tool-call arguments (BATCH-52)', () => {
  it('records a whole message’s calls with their arguments as JSON text, in request order', () => {
    const stats = extractRunStats([
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'search', args: { query: 'laptop', filters: { status: 'open' } } },
          { id: 'c2', name: 'read_file', args: { path: 'a.txt' } },
        ],
      }),
      result('c1', 'search'),
      result('c2', 'read_file'),
    ]);

    expect(stats.toolCalls).toEqual([
      { name: 'search', id: 'c1', args: '{"query":"laptop","filters":{"status":"open"}}' },
      { name: 'read_file', id: 'c2', args: '{"path":"a.txt"}' },
    ]);
  });

  it('reassembles streamed argument fragments per call and records them when the round ends', () => {
    const acc = createRunStatsAccumulator();
    for (const message of [
      chunk([{ index: 0, id: 'c1', name: 'search', args: '{"query":' }]),
      chunk([{ index: 0, args: '"laptop"}' }]),
      chunk([{ index: 1, id: 'c2', name: 'read_file', args: '{"path"' }]),
      chunk([{ index: 1, args: ':"a.txt"}' }]),
      result('c1', 'search'),
      result('c2', 'read_file'),
    ]) {
      accumulateMessage(acc, message);
    }

    expect(finalizeRunStats(acc).toolCalls).toEqual([
      { name: 'search', id: 'c1', args: '{"query":"laptop"}' },
      { name: 'read_file', id: 'c2', args: '{"path":"a.txt"}' },
    ]);
  });

  it('keeps two calls apart when a provider puts both at index 0 under different ids', () => {
    const acc = createRunStatsAccumulator();
    for (const message of [
      chunk([{ id: 'c1', name: 'read_file', args: '{"path":"a.txt"}' }]),
      chunk([{ id: 'c2', name: 'read_file', args: '{"path":"b.txt"}' }]),
      result('c1', 'read_file'),
      result('c2', 'read_file'),
    ]) {
      accumulateMessage(acc, message);
    }

    expect(finalizeRunStats(acc).toolCalls?.map((call) => call.args)).toEqual([
      '{"path":"a.txt"}',
      '{"path":"b.txt"}',
    ]);
  });

  it('restarts indexes each round, so a second round does not append to the first', () => {
    // No ids, as some providers stream: only the round boundary can keep the two calls apart.
    const acc = createRunStatsAccumulator();
    for (const message of [
      chunk([{ index: 0, name: 'search', args: '{"page":1}' }]),
      new ToolMessage({ content: 'ok', tool_call_id: 'x1', name: 'search' }),
      chunk([{ index: 0, name: 'search', args: '{"page":2}' }]),
      new ToolMessage({ content: 'ok', tool_call_id: 'x2', name: 'search' }),
    ]) {
      accumulateMessage(acc, message);
    }

    expect(finalizeRunStats(acc).toolCalls?.map((call) => call.args)).toEqual([
      '{"page":1}',
      '{"page":2}',
    ]);
  });

  it('records a call seen both streamed and as a whole message once', () => {
    const acc = createRunStatsAccumulator();
    for (const message of [
      chunk([{ index: 0, id: 'c1', name: 'search', args: '{"query":"laptop"}' }]),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'search', args: { query: 'laptop' } }],
      }),
      result('c1', 'search'),
    ]) {
      accumulateMessage(acc, message);
    }

    expect(finalizeRunStats(acc).toolCalls).toHaveLength(1);
  });

  it('includes a call still streaming when stats are read, and does not duplicate it later', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(acc, chunk([{ index: 0, id: 'c1', name: 'search', args: '{"q":"x"}' }]));

    expect(finalizeRunStats(acc).toolCalls).toEqual([
      { name: 'search', id: 'c1', args: '{"q":"x"}' },
    ]);

    accumulateMessage(acc, result('c1', 'search'));
    expect(finalizeRunStats(acc).toolCalls).toHaveLength(1);
  });

  it('caps the arguments like a result payload and records that it did', () => {
    const args = { text: 'x'.repeat(100) };
    const stats = extractRunStats(
      [new AIMessage({ content: '', tool_calls: [{ id: 'c1', name: 'write', args }] })],
      [],
      32
    );

    const [call] = stats.toolCalls ?? [];
    expect(call.args).toHaveLength(32);
    expect(call.argsTruncated).toBe(true);
    expect(call.argsOriginalBytes).toBe(JSON.stringify(args).length);
  });

  it('records nothing for a call that never got a name', () => {
    const acc = createRunStatsAccumulator();
    accumulateMessage(acc, chunk([{ index: 0, args: '{"a":1}' }]));
    accumulateMessage(acc, new ToolMessage({ content: 'ok', tool_call_id: 'c1' }));

    expect(finalizeRunStats(acc).toolCalls).toEqual([]);
  });
});
