import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolArgsCheck } from '#src/evalTypes.js';
import type { ToolResultRecord } from '#src/types.js';

/** Shorthand for one recorded tool call: its result record, with the arguments the model sent. */
function call(
  name: string,
  args?: string,
  extra: Partial<ToolResultRecord> = {}
): ToolResultRecord {
  return { name, isError: false, content: 'ok', ...(args !== undefined ? { args } : {}), ...extra };
}

async function grade(toolResults: ToolResultRecord[], ...toolArgs: ToolArgsCheck[]) {
  const { runToolArgsChecks } = await import('#src/toolArgsChecks.js');
  return runToolArgsChecks(toolResults, { toolArgs });
}

const SEARCH = call(
  'mcp__crm__search',
  '{"query":"acme","filters":{"state":"CONNECTED"},"ids":[7,9]}'
);

describe('runToolArgsChecks', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns no failures when the block declares no tool_args entries', async () => {
    expect(await grade([SEARCH])).toEqual([]);
  });

  describe('equals', () => {
    it('passes on a deep-equal value at a nested path', async () => {
      expect(
        await grade([SEARCH], {
          tool: 'mcp__crm__search',
          path: 'filters',
          equals: { state: 'CONNECTED' },
        })
      ).toEqual([]);
    });

    it('resolves array indexes and the $ prefix', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: '$.ids[1]', equals: 9 })
      ).toEqual([]);
    });

    it('fails naming the path, the pattern and the value seen', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__*', path: 'filters.state', equals: 'ARCHIVED' })
      ).toEqual([
        'tool_args "filters.state" (tool "mcp__crm__*"): is "CONNECTED", expected "ARCHIVED"',
      ]);
    });

    it('distinguishes equals: null from a missing key', async () => {
      const nullable = call('t', '{"cursor":null}');
      expect(await grade([nullable], { tool: 't', path: 'cursor', equals: null })).toEqual([]);
      expect(await grade([call('t', '{}')], { tool: 't', path: 'cursor', equals: null })).toEqual([
        'tool_args "cursor" (tool "t"): path did not resolve',
      ]);
    });

    it('fails equals: null against a value that is not null, showing both', async () => {
      expect(
        await grade([call('t', '{"cursor":"abc"}')], { tool: 't', path: 'cursor', equals: null })
      ).toEqual(['tool_args "cursor" (tool "t"): is "abc", expected null']);
    });
  });

  describe('contains', () => {
    it('passes on a substring of a string value', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'query', contains: 'cm' })
      ).toEqual([]);
    });

    it('fails with the value seen when the substring is missing', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'query', contains: 'globex' })
      ).toEqual(['tool_args "query" (tool "mcp__crm__search"): does not contain "globex"']);
    });

    it('fails when the value is not a string', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'ids', contains: '7' })
      ).toEqual([
        'tool_args "ids" (tool "mcp__crm__search"): is [7,9] (contains check requires a string)',
      ]);
    });
  });

  describe('matches', () => {
    it('passes when the regex matches a string value', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'query', matches: /^ac/ })
      ).toEqual([]);
    });

    it('fails naming the pattern when the regex does not match', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'query', matches: /^Acme$/ })
      ).toEqual(['tool_args "query" (tool "mcp__crm__search"): does not match /^Acme$/']);
    });

    it('fails when the value is not a string', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'ids[0]', matches: /7/ })
      ).toEqual([
        'tool_args "ids[0]" (tool "mcp__crm__search"): is 7 (matches check requires a string)',
      ]);
    });
  });

  describe('existence and absent', () => {
    it('an entry with no operator passes when the path resolves and fails when it does not', async () => {
      expect(await grade([SEARCH], { tool: 'mcp__crm__search', path: 'filters.state' })).toEqual(
        []
      );
      expect(await grade([call('t', '{"a":1}')], { tool: 't', path: 'b' })).toEqual([
        'tool_args "b" (tool "t"): path did not resolve',
      ]);
    });

    it('absent passes when the path does not resolve and fails with the value when it does', async () => {
      expect(
        await grade([call('t', '{"a":1}')], { tool: 't', path: 'limit', absent: true })
      ).toEqual([]);
      expect(
        await grade([call('t', '{"limit":500}')], { tool: 't', path: 'limit', absent: true })
      ).toEqual(['tool_args "limit" (tool "t"): is 500, expected the path to be absent']);
    });
  });

  describe('which calls are graded', () => {
    it('fails when no matching tool produced a result, consistent with tool_result_json_path', async () => {
      expect(await grade([call('read_file', '{}')], { tool: 'mcp__*', path: 'q' })).toEqual([
        'tool_args "q" (tool "mcp__*"): no result from a matching tool',
      ]);
      expect(await grade([], { tool: 't', path: 'q' })).toEqual([
        'tool_args "q" (tool "t"): no result from a matching tool',
      ]);
    });

    it('fails for a call whose arguments were not recorded', async () => {
      expect(await grade([call('t')], { tool: 't', path: 'q', absent: true })).toEqual([
        'tool_args "q" (tool "t"): no arguments recorded',
      ]);
    });

    it('passes when only one of several matching calls satisfies the entry', async () => {
      const calls = [call('search_a', '{"q":"one"}'), call('search_b', '{"q":"two"}')];
      expect(await grade(calls, { tool: 'search_*', path: 'q', equals: 'two' })).toEqual([]);
    });

    it('reports each distinct reason once, in call order, when no call satisfies the entry', async () => {
      const calls = [
        call('search_a', '{"q":"one"}'),
        call('search_b', '{"q":"two"}'),
        call('search_a', '{"q":"one"}'),
      ];
      expect(await grade(calls, { tool: 'search_*', path: 'q', equals: 'three' })).toEqual([
        'tool_args "q" (tool "search_*"): is "one", expected "three"; is "two", expected "three"',
      ]);
    });

    it('ignores calls to tools the pattern does not match', async () => {
      const calls = [call('other', '{"q":"three"}'), call('search', '{"q":"one"}')];
      expect(await grade(calls, { tool: 'search', path: 'q', equals: 'three' })).toEqual([
        'tool_args "q" (tool "search"): is "one", expected "three"',
      ]);
    });

    it('produces one failure line per failing entry', async () => {
      expect(
        await grade(
          [SEARCH],
          { tool: 'mcp__crm__search', path: 'query', equals: 'acme' },
          { tool: 'mcp__crm__search', path: 'limit' },
          { tool: 'mcp__crm__search', path: 'ids', absent: true }
        )
      ).toEqual([
        'tool_args "limit" (tool "mcp__crm__search"): path did not resolve',
        'tool_args "ids" (tool "mcp__crm__search"): is [7,9], expected the path to be absent',
      ]);
    });
  });

  describe('arguments that cannot be graded', () => {
    it('fails on arguments that are not JSON, without echoing them', async () => {
      expect(
        await grade([call('step', '{"n":3}{}')], { tool: 'step', path: 'n', equals: 3 })
      ).toEqual(['tool_args "n" (tool "step"): arguments are not JSON']);
    });

    it('fails on truncated arguments before parsing them, naming the key and the original size', async () => {
      // The cut prefix still parses as a number, which is exactly why the flag is read first.
      const truncated = call('t', '12345', { argsTruncated: true, argsOriginalBytes: 9000 });
      expect(await grade([truncated], { tool: 't', path: '$' })).toEqual([
        'tool_args "$" (tool "t"): arguments were truncated at toolResultCaptureMaxBytes ' +
          '(the model sent 9000 bytes); raise toolResultCaptureMaxBytes to capture them whole',
      ]);
    });

    it('grades non-object arguments from their root', async () => {
      expect(
        await grade([call('echo', '"plain"')], { tool: 'echo', path: '$', equals: 'plain' })
      ).toEqual([]);
      expect(
        await grade([call('echo', '"plain"')], { tool: 'echo', path: 'text', absent: true })
      ).toEqual([]);
    });

    it('lets a satisfying call pass the entry even beside one that cannot be graded', async () => {
      const calls = [call('t', 'not json'), call('t'), call('t', '{"q":"x"}')];
      expect(await grade(calls, { tool: 't', path: 'q', equals: 'x' })).toEqual([]);
    });
  });

  describe('every', () => {
    const everyEu = (tool = 'search'): ToolArgsCheck => ({
      tool,
      path: 'region',
      equals: 'EU',
      every: true,
    });

    it('passes when every matching call satisfies the entry', async () => {
      const calls = [call('search', '{"region":"EU"}'), call('search', '{"region":"EU"}')];
      expect(await grade(calls, everyEu())).toEqual([]);
    });

    it('fails when one matching call does not, showing the value that call held', async () => {
      const calls = [call('search', '{"region":"EU"}'), call('search', '{"region":"US"}')];
      expect(await grade(calls, everyEu())).toEqual([
        'tool_args "region" (tool "search"): is "US", expected "EU"',
      ]);
    });

    it('lists each distinct failing reason once, in call order', async () => {
      const calls = [
        call('search', '{"region":"US"}'),
        call('search', '{"region":"EU"}'),
        call('search', '{"region":"US"}'),
        call('search', '{}'),
      ];
      expect(await grade(calls, everyEu())).toEqual([
        'tool_args "region" (tool "search"): is "US", expected "EU"; path did not resolve',
      ]);
    });

    it('fails a call whose arguments cannot be graded', async () => {
      const calls = [call('search', '{"region":"EU"}'), call('search')];
      expect(await grade(calls, everyEu())).toEqual([
        'tool_args "region" (tool "search"): no arguments recorded',
      ]);
    });

    it('applies to every call a glob matches, across tools', async () => {
      const calls = [call('search_a', '{"region":"EU"}'), call('search_b', '{"region":"US"}')];
      expect(await grade(calls, everyEu('search_*'))).toEqual([
        'tool_args "region" (tool "search_*"): is "US", expected "EU"',
      ]);
    });

    it('makes absent a guard: no call may carry the path', async () => {
      const guard: ToolArgsCheck = { tool: 'search', path: 'limit', absent: true, every: true };
      expect(
        await grade([call('search', '{"q":"a"}'), call('search', '{"q":"b"}')], guard)
      ).toEqual([]);
      expect(
        await grade([call('search', '{"q":"a"}'), call('search', '{"q":"b","limit":500}')], guard)
      ).toEqual(['tool_args "limit" (tool "search"): is 500, expected the path to be absent']);
    });

    it('leaves the default at one satisfying call', async () => {
      const calls = [call('search', '{"region":"EU"}'), call('search', '{"region":"US"}')];
      expect(await grade(calls, { tool: 'search', path: 'region', equals: 'EU' })).toEqual([]);
    });

    it('still fails when no matching tool produced a result', async () => {
      expect(await grade([call('other', '{}')], everyEu())).toEqual([
        'tool_args "region" (tool "search"): no result from a matching tool',
      ]);
    });
  });
});
