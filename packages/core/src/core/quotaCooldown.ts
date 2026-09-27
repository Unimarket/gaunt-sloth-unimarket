/**
 * @packageDocumentation
 * CFG-84 — **a short per-minute quota 429 waits out the provider's retry hint.**
 *
 * When a Gemini call fails with a 429 whose quota is per-minute, and the provider names a short
 * wait, wait that long (the LONGER of `RetryInfo.retryDelay` and the prose `Please retry in Ns`),
 * tell the user we are waiting, then re-send, instead of ending the run.
 *
 * ## Design decisions
 *
 * - **The longer wait wins (Andrew, 2026-09-27):** The recorded fixture's two waits disagree:
 *   `RetryInfo` says 14s and prose says 51.4s. Retrying early only earns another 429 and burns a
 *   request against a window that is still closed, so we take the longer of the two.
 * - **Bound: 90 seconds ({@link MAX_QUOTA_COOLDOWN_MS}):** The recorded fixture's longer wait is
 *   51.4s and must cool down, so the bound has to be above that. A named wait above 90s terminates
 *   as today.
 * - **At most 2 cooldowns per turn ({@link MAX_QUOTA_COOLDOWNS_PER_TURN}):** A key that stays
 *   exhausted still ends the run. A third 429 in the same turn terminates as today.
 * - **Per-minute only:** The cooldown fires only when a `QuotaFailure` `quotaId` contains
 *   `PerMinute`, or when there is no `QuotaFailure` but the prose wait is present and within the
 *   bound (matching the 2026-09-27 report which had prose only). A per-day quota returns nothing
 *   and terminates as today.
 * - **Covered providers:** Google Gemini API (`@langchain/google` / AI Studio). Other providers
 *   (OpenAI, Anthropic, Vertex AI, Groq, Ollama, etc.) keep today's behaviour.
 * - **Rater calls out of scope:** AI rater calls on the same key are out of scope for this version.
 * - **EXT-196 balance refusal:** A 403 naming an exhausted balance returns nothing and never
 *   retries; a balance cap does not recover by waiting.
 */

/** Maximum wait duration in milliseconds for a quota cooldown (90 seconds). */
export const MAX_QUOTA_COOLDOWN_MS = 90_000;

/** Maximum number of quota cooldown retries allowed per turn (2). */
export const MAX_QUOTA_COOLDOWNS_PER_TURN = 2;

/** Parsed quota retry hint. */
export interface QuotaRetryHint {
  /** The cooldown duration to wait in milliseconds (the longer of structured and prose waits). */
  waitMs: number;
  /** Whether the quota refusal is per-minute. */
  perMinute: boolean;
}

/**
 * Format the user-visible notification line for a quota cooldown wait.
 *
 * Emitted to `statusUpdate` at {@link StatusLevel.WARNING} so both plain-CLI and Ink TUI
 * surfaces present the wait visibly to the user rather than going silent.
 */
export function quotaCooldownWaitMessage(waitMs: number): string {
  const seconds = Math.max(1, Math.round(waitMs / 1000));
  return `The provider's quota is exhausted; waiting ${seconds} second${seconds === 1 ? '' : 's'} before retrying.`;
}

/** Check if a parsed wait duration is within the accepted cooldown bound (0 < waitMs <= 90s). */
export function isWithinQuotaCooldownBound(waitMs: number): boolean {
  return typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0 && waitMs <= MAX_QUOTA_COOLDOWN_MS;
}

/** Unroll any nested error causes to find the root or inner error payloads. */
function unrollErrors(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let curr = error;
  for (let i = 0; i < 5 && curr; i++) {
    chain.push(curr);
    if (typeof curr === 'object' && curr !== null && 'cause' in curr && (curr as { cause?: unknown }).cause) {
      curr = (curr as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return chain;
}

/** Extract all message strings across the error chain. */
function collectMessages(errors: unknown[]): string {
  const messages: string[] = [];
  for (const err of errors) {
    if (typeof err === 'object' && err !== null) {
      if ('message' in err && typeof (err as { message?: unknown }).message === 'string') {
        messages.push((err as { message: string }).message);
      }
      if ('data' in err) {
        const data = (err as { data?: { error?: { message?: unknown } } }).data;
        if (typeof data?.error?.message === 'string') {
          messages.push(data.error.message);
        }
      }
    }
  }
  return messages.join('\n');
}

/** Parse a protobuf-style duration string like "14s" or "14.5s" into milliseconds. */
function parseDurationSeconds(str: string): number | undefined {
  const match = str.trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i);
  if (!match) return undefined;
  const sec = parseFloat(match[1]);
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : undefined;
}

/** Parse prose retry string like "Please retry in 51.386192716s." into milliseconds. */
function parseProseRetrySeconds(text: string): number | undefined {
  const match = text.match(/Please retry in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (!match) return undefined;
  const sec = parseFloat(match[1]);
  return Number.isFinite(sec) && sec >= 0 ? sec * 1000 : undefined;
}

/**
 * Read the quota retry hint from an error thrown by the model call.
 *
 * Returns `{ waitMs, perMinute: true }` if the error represents a per-minute quota 429
 * from the Gemini API with a retry wait hint.
 * Returns `null` if:
 * - the error is not a 429 quota exhaustion (e.g. 403 balance refusal, 400 invalid request);
 * - the error is not from Gemini API;
 * - the quota is per-day (e.g. QuotaFailure quotaId contains `PerDay` or lacks `PerMinute`);
 * - no wait duration could be parsed;
 * - there is no QuotaFailure and the prose wait is past the bound.
 */
export function readQuotaRetryHint(error: unknown): QuotaRetryHint | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) {
    return null;
  }

  const errors = unrollErrors(error);

  // Check HTTP status: must be 429. An EXT-196 balance refusal (403) or 401/400 must return null.
  let is429 = false;
  let is403 = false;
  for (const err of errors) {
    if (typeof err === 'object' && err !== null) {
      const e = err as {
        statusCode?: unknown;
        status?: unknown;
        data?: { error?: { code?: unknown; status?: unknown } };
      };
      if (e.statusCode === 403 || e.status === 403 || e.data?.error?.code === 403) {
        is403 = true;
      }
      if (
        e.statusCode === 429 ||
        e.status === 429 ||
        e.data?.error?.code === 429 ||
        e.data?.error?.status === 'RESOURCE_EXHAUSTED'
      ) {
        is429 = true;
      }
    }
  }

  if (is403 || !is429) {
    return null;
  }

  // Find response data / details
  let dataDetails: unknown[] | undefined;
  for (const err of errors) {
    if (typeof err === 'object' && err !== null && 'data' in err) {
      const data = (err as { data?: { error?: { details?: unknown[] } } }).data;
      if (Array.isArray(data?.error?.details)) {
        dataDetails = data.error.details;
        break;
      }
    }
  }

  const allMessages = collectMessages(errors);

  // Gemini API check: verify this error is from Google / Gemini API
  const isGoogle =
    errors.some(
      (err) =>
        (err as { name?: string }).name === 'RequestError' ||
        (err as { rateLimitReason?: string }).rateLimitReason === 'quota_message'
    ) ||
    dataDetails?.some(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as { '@type'?: string })['@type'] === 'string' &&
        (d as { '@type': string })['@type'].includes('google.rpc.')
    ) ||
    /ai\.google\.dev|generativelanguage\.googleapis\.com|gemini/i.test(allMessages);

  if (!isGoogle) {
    return null;
  }

  // 1. Parse structured wait from RetryInfo
  let structuredWaitMs: number | undefined;
  if (dataDetails) {
    for (const d of dataDetails) {
      if (
        typeof d === 'object' &&
        d !== null &&
        typeof (d as { '@type'?: string })['@type'] === 'string' &&
        (d as { '@type': string })['@type'].endsWith('RetryInfo')
      ) {
        const retryDelay = (d as { retryDelay?: unknown }).retryDelay;
        if (typeof retryDelay === 'string') {
          structuredWaitMs = parseDurationSeconds(retryDelay);
        }
      }
    }
  }

  // 2. Parse prose wait from "Please retry in <N>s"
  const proseWaitMs = parseProseRetrySeconds(allMessages);

  // If neither wait is found, nothing to cool down
  if (structuredWaitMs === undefined && proseWaitMs === undefined) {
    return null;
  }

  // Andrew's ruling (2026-09-27): the longer wait wins
  const waitMs =
    structuredWaitMs !== undefined && proseWaitMs !== undefined
      ? Math.max(structuredWaitMs, proseWaitMs)
      : (structuredWaitMs ?? proseWaitMs!);

  // 3. Inspect QuotaFailure for per-minute vs per-day discrimination
  let quotaFailureDetails: Array<{ violations?: Array<{ quotaId?: string }> }> | undefined;
  if (dataDetails) {
    quotaFailureDetails = dataDetails.filter(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as { '@type'?: string })['@type'] === 'string' &&
        (d as { '@type': string })['@type'].endsWith('QuotaFailure')
    ) as Array<{ violations?: Array<{ quotaId?: string }> }>;
  }

  if (quotaFailureDetails && quotaFailureDetails.length > 0) {
    const allViolations = quotaFailureDetails.flatMap((qf) => qf.violations ?? []);
    const hasPerMinute = allViolations.some(
      (v) => typeof v?.quotaId === 'string' && v.quotaId.includes('PerMinute')
    );
    // If QuotaFailure is present but lacks PerMinute (e.g. PerDay), return null
    if (!hasPerMinute) {
      return null;
    }
    return { waitMs, perMinute: true };
  }

  // If no QuotaFailure is present: the 2026-09-27 report had prose only.
  // The cooldown fires only if the prose wait is present and within the bound.
  if (proseWaitMs !== undefined && waitMs <= MAX_QUOTA_COOLDOWN_MS) {
    return { waitMs, perMinute: true };
  }

  return null;
}
