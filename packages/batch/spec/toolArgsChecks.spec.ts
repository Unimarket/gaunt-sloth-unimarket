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

    it('fails naming the path, the pattern, the tool called and the value seen', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__*', path: 'filters.state', equals: 'ARCHIVED' })
      ).toEqual([
        'tool_args "filters.state" (tool "mcp__crm__*"): mcp__crm__search: is "CONNECTED", ' +
          'expected "ARCHIVED"',
      ]);
    });

    it('distinguishes equals: null from a missing key', async () => {
      const nullable = call('t', '{"cursor":null}');
      expect(await grade([nullable], { tool: 't', path: 'cursor', equals: null })).toEqual([]);
      expect(await grade([call('t', '{}')], { tool: 't', path: 'cursor', equals: null })).toEqual([
        'tool_args "cursor" (tool "t"): t: path did not resolve in {}',
      ]);
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
      ).toEqual([
        'tool_args "query" (tool "mcp__crm__search"): mcp__crm__search: is "acme", which does not ' +
          'contain "globex"',
      ]);
    });

    it('fails when the value is not a string', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'ids', contains: '7' })
      ).toEqual([
        'tool_args "ids" (tool "mcp__crm__search"): mcp__crm__search: is [7,9] (contains check ' +
          'requires a string)',
      ]);
    });
  });

  describe('matches', () => {
    it('passes when the regex matches a string value', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'query', matches: /^ac/ })
      ).toEqual([]);
    });

    it('fails with the value and the pattern when the regex does not match', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'query', matches: /^Acme$/ })
      ).toEqual([
        'tool_args "query" (tool "mcp__crm__search"): mcp__crm__search: is "acme", which does not ' +
          'match /^Acme$/',
      ]);
    });

    it('fails when the value is not a string', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'ids[0]', matches: /7/ })
      ).toEqual([
        'tool_args "ids[0]" (tool "mcp__crm__search"): mcp__crm__search: is 7 (matches check ' +
          'requires a string)',
      ]);
    });

    it('gives the same answer each time a check is graded when the pattern carries the g flag', async () => {
      // A suite's pattern is compiled once and graded against every cell. `test()` on a global
      // regex resumes at the `lastIndex` its previous match left, so the second cell would fail.
      const check: ToolArgsCheck = { tool: 't', path: 'q', matches: /a/g };
      const calls = [call('t', '{"q":"xa"}')];
      expect(await grade(calls, check)).toEqual([]);
      expect(await grade(calls, check)).toEqual([]);
    });
  });

  describe('exists and absent', () => {
    it('exists passes when the path resolves and fails when it does not', async () => {
      expect(
        await grade([SEARCH], { tool: 'mcp__crm__search', path: 'filters.state', exists: true })
      ).toEqual([]);
      expect(await grade([call('t', '{"a":1}')], { tool: 't', path: 'b', exists: true })).toEqual([
        'tool_args "b" (tool "t"): t: path did not resolve in {"a":1}',
      ]);
    });

    it('absent passes when the path does not resolve and fails with the value when it does', async () => {
      expect(
        await grade([call('t', '{"a":1}')], { tool: 't', path: 'limit', absent: true })
      ).toEqual([]);
      expect(
        await grade([call('t', '{"limit":500}')], { tool: 't', path: 'limit', absent: true })
      ).toEqual(['tool_args "limit" (tool "t"): t: is 500, expected the path to be absent']);
    });
  });

  describe('which calls are graded', () => {
    it('fails when no matching tool produced a result, consistent with tool_result_json_path', async () => {
      expect(
        await grade([call('read_file', '{}')], { tool: 'mcp__*', path: 'q', exists: true })
      ).toEqual(['tool_args "q" (tool "mcp__*"): no result from a matching tool']);
      expect(await grade([], { tool: 't', path: 'q', exists: true })).toEqual([
        'tool_args "q" (tool "t"): no result from a matching tool',
      ]);
    });

    it('fails for a call whose arguments were not recorded', async () => {
      expect(await grade([call('t')], { tool: 't', path: 'q', absent: true })).toEqual([
        'tool_args "q" (tool "t"): t: no arguments recorded',
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
        'tool_args "q" (tool "search_*"): search_a: is "one", expected "three"; ' +
          'search_b: is "two", expected "three"',
      ]);
    });

    it('ignores calls to tools the pattern does not match', async () => {
      const calls = [call('other', '{"q":"three"}'), call('search', '{"q":"one"}')];
      expect(await grade(calls, { tool: 'search', path: 'q', equals: 'three' })).toEqual([
        'tool_args "q" (tool "search"): search: is "one", expected "three"',
      ]);
    });

    it('produces one failure line per failing entry', async () => {
      expect(
        await grade(
          [SEARCH],
          { tool: 'mcp__crm__search', path: 'query', equals: 'acme' },
          { tool: 'mcp__crm__search', path: 'limit', exists: true },
          { tool: 'mcp__crm__search', path: 'ids', absent: true }
        )
      ).toEqual([
        'tool_args "limit" (tool "mcp__crm__search"): mcp__crm__search: path did not resolve in ' +
          SEARCH.args,
        'tool_args "ids" (tool "mcp__crm__search"): mcp__crm__search: is [7,9], expected the path ' +
          'to be absent',
      ]);
    });
  });

  describe('arguments that cannot be graded', () => {
    it('fails on arguments that are not JSON, showing what was recorded', async () => {
      expect(
        await grade([call('step', '{"n":3}{}')], { tool: 'step', path: 'n', equals: 3 })
      ).toEqual(['tool_args "n" (tool "step"): step: arguments are not JSON: {"n":3}{}']);
    });

    it('fails on truncated arguments before parsing them, naming the key and the original size', async () => {
      // The cut prefix still parses as a number, which is exactly why the flag is read first.
      const truncated = call('t', '12345', { argsTruncated: true, argsOriginalBytes: 9000 });
      expect(await grade([truncated], { tool: 't', path: '$', exists: true })).toEqual([
        'tool_args "$" (tool "t"): t: arguments were truncated at toolResultCaptureMaxBytes ' +
          '(the model sent 9000 bytes); raise toolResultCaptureMaxBytes to capture them whole',
      ]);
    });

    it('names the key even when the original size was not recorded', async () => {
      const truncated = call('t', '{"q":"ab', { argsTruncated: true });
      expect(await grade([truncated], { tool: 't', path: 'q', absent: true })).toEqual([
        'tool_args "q" (tool "t"): t: arguments were truncated at toolResultCaptureMaxBytes; ' +
          'raise toolResultCaptureMaxBytes to capture them whole',
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
});
