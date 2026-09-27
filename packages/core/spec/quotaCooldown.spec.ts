import { describe, expect, it } from 'vitest';
import {
  isWithinQuotaCooldownBound,
  MAX_QUOTA_COOLDOWN_MS,
  MAX_QUOTA_COOLDOWNS_PER_TURN,
  quotaCooldownWaitMessage,
  readQuotaRetryHint,
} from '#src/core/quotaCooldown.js';

/**
 * Recorded 2026-09-12 — a real 429.
 * Note: retryDelay is 14s, while prose retry is 51.386192716s.
 */
const RECORDED_QUOTA_429 = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. For more ' +
      'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To ' +
      'monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for ' +
      'metric: generativelanguage.googleapis.com/generate_content_paid_tier_2_input_token_count, ' +
      'limit: 3000000, model: gemini-3.8-flash\nPlease retry in 51.386192716s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_paid_tier_2_input_token_count',
            quotaId: 'GenerateContentPaidTierInputTokensPerModelPerMinute-PaidTier2',
            quotaDimensions: { location: 'global', model: 'gemini-3.8-flash' },
            quotaValue: '3000000',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '14s' },
    ],
  },
};

/**
 * 2026-09-27 report shape — prose only, no QuotaFailure details object.
 */
const REPORT_PROSE_ONLY_429_MESSAGE =
  'You exceeded your current quota, please check your plan and billing details. For more information on this error, ' +
  'head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head ' +
  'to: https://ai.dev/rate-limit.\n' +
  '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_2_input_token_count, ' +
  'limit: 3000000, model: gemini-3.8-flash\n' +
  'Please retry in 9.465979368s.';

describe('CFG-84 — readQuotaRetryHint reader', () => {
  it('reads RECORDED_QUOTA_429: the longer wait (51.4s) wins over RetryInfo (14s)', () => {
    const error = new Error(RECORDED_QUOTA_429.error.message) as Error & {
      name: string;
      statusCode: number;
      data: unknown;
    };
    error.name = 'RequestError';
    error.statusCode = 429;
    error.data = RECORDED_QUOTA_429;

    const hint = readQuotaRetryHint(error);
    expect(hint).not.toBeNull();
    expect(hint?.perMinute).toBe(true);
    // 51.386192716s is ~51386.19ms, which wins over 14000ms
    expect(hint?.waitMs).toBeCloseTo(51386.19, 1);
    expect(Math.round(hint!.waitMs / 100) / 10).toBe(51.4);
  });

  it('reads prose-only shape (2026-09-27 report) with no QuotaFailure', () => {
    const error = new Error(REPORT_PROSE_ONLY_429_MESSAGE) as Error & {
      name: string;
      statusCode: number;
    };
    error.name = 'RequestError';
    error.statusCode = 429;

    const hint = readQuotaRetryHint(error);
    expect(hint).not.toBeNull();
    expect(hint?.perMinute).toBe(true);
    // 9.465979368s is ~9465.98ms
    expect(hint?.waitMs).toBeCloseTo(9465.98, 1);
  });

  it('returns null on a per-day quotaId (e.g. GenerateContentPaidTierRequestsPerDay)', () => {
    const perDayData = {
      error: {
        code: 429,
        message: 'Quota exceeded for metric: requests. Please retry in 10s.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [
              {
                quotaMetric: 'generativelanguage.googleapis.com/requests',
                quotaId: 'GenerateContentPaidTierRequestsPerDay-PaidTier2',
              },
            ],
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '10s' },
        ],
      },
    };
    const error = new Error(perDayData.error.message) as Error & {
      name: string;
      statusCode: number;
      data: unknown;
    };
    error.name = 'RequestError';
    error.statusCode = 429;
    error.data = perDayData;

    const hint = readQuotaRetryHint(error);
    expect(hint).toBeNull();
  });

  it('returns null on an EXT-196-shaped balance 403', () => {
    const error = new Error(
      'Your account balance has been exhausted or spending limit reached.'
    ) as Error & {
      name: string;
      statusCode: number;
      status: number;
    };
    error.name = 'RequestError';
    error.statusCode = 403;
    error.status = 403;

    const hint = readQuotaRetryHint(error);
    expect(hint).toBeNull();
  });

  it('returns null if prose wait in prose-only shape exceeds the 90s bound', () => {
    const error = new Error(
      'https://ai.google.dev/gemini-api/docs/rate-limits: Quota exceeded for metric: tokens. Please retry in 120s.'
    ) as Error & {
      name: string;
      statusCode: number;
    };
    error.name = 'RequestError';
    error.statusCode = 429;

    const hint = readQuotaRetryHint(error);
    expect(hint).toBeNull();
  });

  it('returns null if no wait is named at all', () => {
    const error = new Error('https://ai.google.dev/gemini-api: Quota exceeded.') as Error & {
      name: string;
      statusCode: number;
    };
    error.name = 'RequestError';
    error.statusCode = 429;

    const hint = readQuotaRetryHint(error);
    expect(hint).toBeNull();
  });

  it('unrolls error.cause when error is wrapped by runner or stream', () => {
    const innerError = new Error(RECORDED_QUOTA_429.error.message) as Error & {
      name: string;
      statusCode: number;
      data: unknown;
    };
    innerError.name = 'RequestError';
    innerError.statusCode = 429;
    innerError.data = RECORDED_QUOTA_429;

    const wrapper = new Error(`Stream processing failed: ${innerError.message}`, {
      cause: innerError,
    });

    const hint = readQuotaRetryHint(wrapper);
    expect(hint).not.toBeNull();
    expect(hint?.waitMs).toBeCloseTo(51386.19, 1);
    expect(hint?.perMinute).toBe(true);
  });

  it('returns null for other providers (e.g. OpenAI rate limit with no Gemini markings)', () => {
    const error = new Error('Rate limit reached for default-gpt-4o. Please retry in 5s.') as Error & {
      statusCode: number;
    };
    error.statusCode = 429;

    const hint = readQuotaRetryHint(error);
    expect(hint).toBeNull();
  });
});

describe('CFG-84 — constants and wait line helper', () => {
  it('defines MAX_QUOTA_COOLDOWN_MS as 90 seconds', () => {
    expect(MAX_QUOTA_COOLDOWN_MS).toBe(90_000);
    expect(isWithinQuotaCooldownBound(90_000)).toBe(true);
    expect(isWithinQuotaCooldownBound(90_001)).toBe(false);
    expect(isWithinQuotaCooldownBound(0)).toBe(false);
    expect(isWithinQuotaCooldownBound(-100)).toBe(false);
  });

  it('defines MAX_QUOTA_COOLDOWNS_PER_TURN as 2', () => {
    expect(MAX_QUOTA_COOLDOWNS_PER_TURN).toBe(2);
  });

  it('formats wait message correctly for plural and singular seconds', () => {
    expect(quotaCooldownWaitMessage(51_386)).toBe(
      "The provider's quota is exhausted; waiting 51 seconds before retrying."
    );
    expect(quotaCooldownWaitMessage(14_000)).toBe(
      "The provider's quota is exhausted; waiting 14 seconds before retrying."
    );
    expect(quotaCooldownWaitMessage(1_000)).toBe(
      "The provider's quota is exhausted; waiting 1 second before retrying."
    );
  });
});
