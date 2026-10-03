import { resolveJsonPath } from '#src/deterministicChecks.js';
import type { EvalExpectation, ToolArgsCheck } from '#src/evalTypes.js';
import { gradeMatchingResults, gradeResolvedValue } from '#src/toolCheckGrading.js';
import type { ToolResultRecord } from '#src/types.js';

/**
 * Tool-ARGUMENT assertions — grade a cell against what the model asked its tools to do: the
 * arguments recorded on each tool result (`ToolResultRecord.args`). Tool names are matched with
 * `toolNameMatchesPattern` (exact or glob) and paths are resolved with `resolveJsonPath`.
 *
 * Each `toolArgs` entry passes iff **at least one** recorded call to a tool matching its `tool`
 * pattern satisfies it, or, with `every`, iff every such call does. Per call, in order:
 * - no recorded arguments, arguments cut at `toolResultCaptureMaxBytes`, and arguments that do not
 *   parse as JSON are each a failure with its own reason, never a throw;
 * - `absent` passes when `path` does not resolve;
 * - every other entry first needs `path` to resolve, then `equals` deep-equals, `contains`
 *   substring-matches a string, and `matches` regex-matches a string. With none of them the
 *   resolved path is enough.
 *
 * A failing entry produces ONE line naming the path and the tool pattern, followed by the distinct
 * per-call reasons.
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

/** Grade one {@link ToolArgsCheck}: `undefined` when the matching calls satisfy it, else ONE
 * failure line (per check, not per call) naming the path + tool pattern and the distinct per-call
 * reasons. */
function checkToolArgs(toolResults: ToolResultRecord[], check: ToolArgsCheck): string | undefined {
  const label = `tool_args "${check.path}" (tool "${check.tool}")`;
  return gradeMatchingResults(
    toolResults,
    check.tool,
    label,
    (result) => evaluateCallAgainstCheck(result, check),
    check.every === true
  );
}

/**
 * The reason for arguments that capture cut, naming the key to raise and the size the model sent.
 * Checked before the parse, because a cut prefix (of a long number, say) can still parse and would
 * then be graded as something the model did not send.
 */
function truncatedArgsReason(originalBytes: number | undefined): string {
  return (
    `arguments were truncated at toolResultCaptureMaxBytes (the model sent ${originalBytes} ` +
    'bytes); raise toolResultCaptureMaxBytes to capture them whole'
  );
}

/** Evaluate ONE recorded call against ONE check: `undefined` = satisfied, else the reason.
 * Deterministic and throw-free: absent or non-JSON arguments are a reason, not an exception. */
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
    return 'arguments are not JSON';
  }

  const { found, value } = resolveJsonPath(root, check.path);
  if (check.absent) {
    return found ? `is ${JSON.stringify(value)}, expected the path to be absent` : undefined;
  }
  if (!found) {
    return 'path did not resolve';
  }

  if (check.matches !== undefined) {
    if (typeof value !== 'string') {
      return `is ${JSON.stringify(value)} (matches check requires a string)`;
    }
    return value.search(check.matches) === -1 ? `does not match ${check.matches}` : undefined;
  }

  return gradeResolvedValue(value, check);
}
