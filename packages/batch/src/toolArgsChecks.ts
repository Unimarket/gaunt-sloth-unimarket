import { isDeepStrictEqual } from 'node:util';

import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import { resolveJsonPath } from '#src/deterministicChecks.js';
import type { EvalExpectation, ToolArgsCheck } from '#src/evalTypes.js';
import type { ToolResultRecord } from '#src/types.js';

/**
 * Tool-ARGUMENT assertions — grade a cell against what the model asked its tools to do: the
 * arguments recorded on each tool result (`ToolResultRecord.args`). Tool names are matched with
 * `toolNameMatchesPattern` (exact or glob) and paths are resolved with `resolveJsonPath`.
 *
 * Each `toolArgs` entry passes iff **at least one** recorded call to a tool matching its `tool`
 * pattern satisfies it. Per call, in order:
 * - no recorded arguments, arguments cut at `toolResultCaptureMaxBytes`, and arguments that do not
 *   parse as JSON are each a failure with its own reason, never a throw;
 * - `absent` passes when `path` does not resolve;
 * - every other operator first needs `path` to resolve, then `equals` deep-equals, `contains`
 *   substring-matches a string, `matches` regex-matches a string, and `exists` asks nothing more.
 *
 * A failing entry produces ONE line naming the path and the tool pattern, followed by the distinct
 * per-call reasons, each naming the tool that was called and what its arguments held.
 */
export function runToolArgsChecks(
  toolResults: ToolResultRecord[],
  expectation: Pick<EvalExpectation, 'toolArgs'>
): string[] {
  const failures: string[] = [];
  for (const check of expectation.toolArgs) {
    const failure = checkToolArgs(toolResults, check);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
}

/** Grade one {@link ToolArgsCheck}: `undefined` when at least one matching call satisfies it,
 * else one failure line with the distinct per-call reasons in first-seen order. */
function checkToolArgs(toolResults: ToolResultRecord[], check: ToolArgsCheck): string | undefined {
  const label = `tool_args "${check.path}" (tool "${check.tool}")`;
  const matching = toolResults.filter((result) => toolNameMatchesPattern(result.name, check.tool));
  if (matching.length === 0) {
    return `${label}: no result from a matching tool`;
  }

  const reasons = new Set<string>();
  for (const result of matching) {
    const reason = evaluateCallAgainstCheck(result, check);
    if (reason === undefined) return undefined;
    reasons.add(`${result.name}: ${reason}`);
  }
  return `${label}: ${[...reasons].join('; ')}`;
}

/**
 * The reason for arguments that capture cut, naming the key to raise and, when recorded, the size
 * the model sent. Checked before the parse, because a cut prefix (of a long number, say) can still
 * parse and would then be graded as something the model did not send.
 */
function truncatedArgsReason(originalBytes: number | undefined): string {
  const measured =
    typeof originalBytes === 'number' ? ` (the model sent ${originalBytes} bytes)` : '';
  return (
    'arguments were truncated at toolResultCaptureMaxBytes' +
    measured +
    '; raise toolResultCaptureMaxBytes to capture them whole'
  );
}

/** Evaluate ONE recorded call against ONE check: `undefined` = satisfied, else the reason. */
function evaluateCallAgainstCheck(
  result: ToolResultRecord,
  check: ToolArgsCheck
): string | undefined {
  if (result.args === undefined) {
    return 'no arguments recorded';
  }
  if (result.argsTruncated) {
    return truncatedArgsReason(result.argsOriginalBytes);
  }
  let root: unknown;
  try {
    root = JSON.parse(result.args);
  } catch {
    return `arguments are not JSON: ${result.args}`;
  }

  const { found, value } = resolveJsonPath(root, check.path);
  if (check.absent) {
    return found ? `is ${JSON.stringify(value)}, expected the path to be absent` : undefined;
  }
  if (!found) {
    return `path did not resolve in ${result.args}`;
  }

  if (check.contains !== undefined) {
    if (typeof value !== 'string') {
      return `is ${JSON.stringify(value)} (contains check requires a string)`;
    }
    return value.includes(check.contains)
      ? undefined
      : `is ${JSON.stringify(value)}, which does not contain "${check.contains}"`;
  }

  if (check.matches !== undefined) {
    if (typeof value !== 'string') {
      return `is ${JSON.stringify(value)} (matches check requires a string)`;
    }
    // `search` ignores `lastIndex`, so a stored `g`-flagged pattern grades every cell alike.
    return value.search(check.matches) !== -1
      ? undefined
      : `is ${JSON.stringify(value)}, which does not match ${check.matches}`;
  }

  // `equals` may legitimately be `null`, so discriminate on KEY presence; the parser keeps exactly
  // one operator key on every entry.
  if ('equals' in check) {
    return isDeepStrictEqual(value, check.equals)
      ? undefined
      : `is ${JSON.stringify(value)}, expected ${JSON.stringify(check.equals)}`;
  }

  // `exists`: the resolved path is enough.
  return undefined;
}
