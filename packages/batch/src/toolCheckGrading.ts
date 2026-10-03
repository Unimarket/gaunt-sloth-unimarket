import { isDeepStrictEqual } from 'node:util';

import { toolNameMatchesPattern } from '@gaunt-sloth/core/utils/toolMatching.js';

import type { ToolResultRecord } from '#src/types.js';

/** What a resolved value is compared with: a substring, a deep-equal value, or neither. */
export interface ValueExpectation {
  equals?: unknown;
  contains?: string;
}

/**
 * Grade a value a check's `path` resolved to: `undefined` when it satisfies `expected`, else the
 * reason. `contains` needs a string value and asks for the substring; `equals` deep-equals. Neither
 * is a pure existence check, which a resolved path already satisfies.
 *
 * `equals` may legitimately be `null`, so it is discriminated on KEY presence, not on its value.
 */
export function gradeResolvedValue(value: unknown, expected: ValueExpectation): string | undefined {
  if (expected.contains !== undefined) {
    if (typeof value !== 'string') {
      return `is ${JSON.stringify(value)} (contains check requires a string)`;
    }
    if (!value.includes(expected.contains)) {
      return `does not contain "${expected.contains}"`;
    }
    return undefined;
  }

  if ('equals' in expected && !isDeepStrictEqual(value, expected.equals)) {
    return `is ${JSON.stringify(value)}, expected ${JSON.stringify(expected.equals)}`;
  }

  return undefined;
}

/**
 * Grade the tool results whose name matches `toolPattern` (exact or glob) with `evaluate`, which
 * returns `undefined` for a result that satisfies the check and else the reason. Returns
 * `undefined` when the check holds, else ONE failure line (per check, not per result): `label`
 * followed by the distinct reasons in first-seen order.
 *
 * The check holds when at least one matching result satisfies it, or with `every`, when all of
 * them do. No matching result fails it either way.
 */
export function gradeMatchingResults(
  toolResults: ToolResultRecord[],
  toolPattern: string,
  label: string,
  evaluate: (result: ToolResultRecord) => string | undefined,
  every = false
): string | undefined {
  const matching = toolResults.filter((result) => toolNameMatchesPattern(result.name, toolPattern));
  if (matching.length === 0) {
    return `${label}: no result from a matching tool`;
  }

  const reasons = new Set<string>();
  for (const result of matching) {
    const reason = evaluate(result);
    if (reason !== undefined) {
      reasons.add(reason);
    } else if (!every) {
      return undefined;
    }
  }
  return reasons.size === 0 ? undefined : `${label}: ${[...reasons].join('; ')}`;
}
