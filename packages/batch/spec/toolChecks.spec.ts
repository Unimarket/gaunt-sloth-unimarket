import { describe, expect, it } from 'vitest';
import type { ToolCallRecord } from '#src/types.js';

describe('runToolCallChecks', () => {
  it('passes when every must_call pattern matched and no must_not_call pattern did', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['mcp__unimarket__search', 'thinking'], {
      mustCall: ['mcp__*'],
      mustNotCall: ['read_file', 'gth_grep'],
    });
    expect(failures).toEqual([]);
  });

  it('fails a must_call pattern that no called tool matches', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['read_file'], {
      mustCall: ['mcp__*'],
      mustNotCall: [],
    });
    expect(failures).toEqual(['did not call "mcp__*"']);
  });

  it('fails each forbidden tool that was called, naming the tool and the matched pattern', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['read_file', 'gth_grep', 'thinking'], {
      mustCall: [],
      mustNotCall: ['read_file', 'gth_grep'],
    });
    expect(failures).toEqual([
      'called forbidden tool "read_file" (matched "read_file")',
      'called forbidden tool "gth_grep" (matched "gth_grep")',
    ]);
  });

  it('matches must_not_call by glob too', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['mcp__unimarket__buy'], {
      mustCall: [],
      mustNotCall: ['mcp__*'],
    });
    expect(failures).toEqual(['called forbidden tool "mcp__unimarket__buy" (matched "mcp__*")']);
  });

  it('combines a must_call miss and a must_not_call hit (the acceptance shape)', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    // tools === ['read_file'] must FAIL both: it never called mcp, and it called a forbidden tool.
    const failures = runToolCallChecks(['read_file'], {
      mustCall: ['mcp__*'],
      mustNotCall: ['read_file', 'gth_grep'],
    });
    expect(failures).toEqual([
      'did not call "mcp__*"',
      'called forbidden tool "read_file" (matched "read_file")',
    ]);
  });

  it('reports a repeated forbidden tool only once (de-duped, not once per call)', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallChecks(['read_file', 'read_file', 'read_file'], {
      mustCall: [],
      mustNotCall: ['read_file'],
    });
    expect(failures).toEqual(['called forbidden tool "read_file" (matched "read_file")']);
  });

  it('passes trivially when both lists are empty (nothing to assert)', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    expect(runToolCallChecks(['anything'], { mustCall: [], mustNotCall: [] })).toEqual([]);
  });

  it('fails a must_call when no tools were called at all', async () => {
    const { runToolCallChecks } = await import('#src/toolChecks.js');
    expect(runToolCallChecks([], { mustCall: ['mcp__*'], mustNotCall: [] })).toEqual([
      'did not call "mcp__*"',
    ]);
  });
});

describe('runToolCallArgChecks — tool_call_json_path (BATCH-52)', () => {
  const search = (args: string, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
    name: 'mcp__shop__search',
    args,
    ...extra,
  });

  it('passes on equals, contains and existence against a matching call’s arguments', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks(
      [search('{"query":"laptop bags","filters":{"status":"open"}}')],
      {
        toolCallJsonPath: [
          { tool: 'mcp__shop__search', path: 'filters.status', equals: 'open' },
          { tool: 'mcp__shop__*', path: 'query', contains: 'laptop' },
          { tool: 'mcp__shop__search', path: 'filters' },
        ],
      }
    );
    expect(failures).toEqual([]);
  });

  it('fails with the value it found when equals does not hold', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"filters":{"status":"closed"}}')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'filters.status', equals: 'open' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "filters.status" (tool "mcp__shop__search"): is "closed", expected "open"',
    ]);
  });

  it('passes when ANY of several calls to the tool satisfies it', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"page":1}'), search('{"page":2}')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'page', equals: 2 }],
    });
    expect(failures).toEqual([]);
  });

  it('fails when no call matches the tool pattern', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([{ name: 'read_file', args: '{"path":"a"}' }], {
      toolCallJsonPath: [{ tool: 'mcp__shop__*', path: 'query' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__*"): no call to a matching tool',
    ]);
  });

  it('fails deterministically on arguments that are not JSON', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('{"query":')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__search"): arguments are not JSON',
    ]);
  });

  it('grades a call with no arguments as an empty object', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks([search('')], {
      toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query' }],
    });
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__search"): path did not resolve',
    ]);
  });

  it('names toolResultCaptureMaxBytes when the arguments were cut, even if the prefix parses', async () => {
    const { runToolCallArgChecks } = await import('#src/toolChecks.js');
    const failures = runToolCallArgChecks(
      [search('{"query":"x"}', { argsTruncated: true, argsOriginalBytes: 9000 })],
      { toolCallJsonPath: [{ tool: 'mcp__shop__search', path: 'query' }] }
    );
    expect(failures).toEqual([
      'tool_call_json_path "query" (tool "mcp__shop__search"): arguments were truncated at ' +
        'toolResultCaptureMaxBytes (the call sent 9000 bytes); raise toolResultCaptureMaxBytes ' +
        'to capture them whole',
    ]);
  });
});
