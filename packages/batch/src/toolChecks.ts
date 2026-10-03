import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import type { EvalExpectation, ToolCallJsonPathCheck } from '#src/evalTypes.js';
import { resolveJsonPath } from '#src/deterministicChecks.js';
import { gradeJsonPathValue } from '#src/toolResultChecks.js';
import type { ToolCallRecord } from '#src/types.js';

/**
 * BATCH-10 tool-trace assertions — grade a case against the tool *names* it actually invoked
 * (`cellResult.tools`), rather than grepping the answer text. This "kills the false-positive class
 * structurally": an MCP-only case can prove the server was called instead of a substring that a
 * hallucinated answer could also contain.
 *
 * Kept separate from `runDeterministicChecks` (which reads the *answer*) on purpose — these read the
 * tool trace — so neither signature is muddied. Patterns reuse GS2-61's `toolNameMatchesPattern`
 * (`@gaunt-sloth/core`), the same glob/exact matcher `allowedTools` uses, so `mcp__unimarket__*`
 * behaves identically here.
 *
 * - `mustCall` — for **each** pattern, at least one called tool must match it, else
 *   `did not call "<pattern>"`.
 * - `mustNotCall` — **no** called tool may match any forbidden pattern; each offending tool is
 *   reported once as `called forbidden tool "<tool>" (matched "<pattern>")`.
 *
 * BATCH-12: grades one {@link EvalExpectation} block's tool-trace assertions (a flat case's single
 * block or a matrix case's identity-scoped block) — same field names, same behavior as before.
 */
export function runToolCallChecks(
  tools: string[],
  expectation: Pick<EvalExpectation, 'mustCall' | 'mustNotCall'>
): string[] {
  const failures: string[] = [];

  for (const pattern of expectation.mustCall) {
    if (!tools.some((tool) => toolNameMatchesPattern(tool, pattern))) {
      failures.push(`did not call "${pattern}"`);
    }
  }

  // De-duplicate: a tool called N times (traces realistically repeat names) is one violation, not
  // N identical failure lines. `Set` preserves first-seen order.
  for (const tool of new Set(tools)) {
    const matched = expectation.mustNotCall.find((pattern) =>
      toolNameMatchesPattern(tool, pattern)
    );
    if (matched !== undefined) {
      failures.push(`called forbidden tool "${tool}" (matched "${matched}")`);
    }
  }

  return failures;
}

/**
 * BATCH-52 tool-call ARGUMENT assertions — grade a cell against the arguments its tools were
 * called WITH (`toolCalls`, captured only when the run sets `evalToolCallArgs`), for a suite where
 * the fact of the call is not enough.
 *
 * Each `tool_call_json_path` entry selects the calls whose name matches its `tool` pattern (the
 * `must_call` matcher), parses each call's arguments as JSON and applies `path` with `equals` /
 * `contains` / `matches` / existence — the same evaluator `tool_result_json_path` uses on a result.
 * `present: false` inverts the existence check: the call satisfies the entry when the path does not
 * resolve. The entry passes iff **at least one** matching call satisfies it, or with `allCalls`
 * iff **every** matching call does; otherwise ONE failure line names the path, the pattern and the
 * distinct per-call reasons. No matching call at all always fails. Arguments cut at the capture
 * cap fail with a reason naming `toolResultCaptureMaxBytes` rather than being graded as a prefix.
 */
export function runToolCallArgChecks(
  toolCalls: ToolCallRecord[],
  expectation: Pick<EvalExpectation, 'toolCallJsonPath'>
): string[] {
  const failures: string[] = [];
  for (const check of expectation.toolCallJsonPath) {
    const failure = checkToolCallJsonPath(toolCalls, check);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

function checkToolCallJsonPath(
  toolCalls: ToolCallRecord[],
  check: ToolCallJsonPathCheck
): string | undefined {
  const label = `tool_call_json_path "${check.path}" (tool "${check.tool}")`;
  const matching = toolCalls.filter((call) => toolNameMatchesPattern(call.name, check.tool));
  if (matching.length === 0) {
    return `${label}: no call to a matching tool`;
  }
  const reasons = new Set<string>();
  for (const call of matching) {
    const reason = evaluateCallAgainstCheck(call, check);
    if (reason === undefined) {
      if (!check.allCalls) return undefined;
    } else {
      reasons.add(reason);
    }
  }
  return reasons.size === 0 ? undefined : `${label}: ${[...reasons].join('; ')}`;
}

function evaluateCallAgainstCheck(
  call: ToolCallRecord,
  check: ToolCallJsonPathCheck
): string | undefined {
  if (call.argsTruncated) {
    const measured =
      typeof call.argsOriginalBytes === 'number'
        ? ` (the call sent ${call.argsOriginalBytes} bytes)`
        : '';
    return (
      'arguments were truncated at toolResultCaptureMaxBytes' +
      measured +
      '; raise toolResultCaptureMaxBytes to capture them whole'
    );
  }
  // A call with no arguments at all is graded as an empty object, so its reason is the path
  // that did not resolve rather than a parse failure the model never caused.
  const text = (call.args ?? '').trim() || '{}';
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return 'arguments are not JSON';
  }
  if (check.present === false) {
    const { found, value } = resolveJsonPath(root, check.path);
    return found ? `path is present with ${JSON.stringify(value)}` : undefined;
  }
  return gradeJsonPathValue(root, check);
}
