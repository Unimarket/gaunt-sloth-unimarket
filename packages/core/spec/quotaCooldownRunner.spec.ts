import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '#src/config.js';
import { StatusLevel } from '#src/core/types.js';
import * as su from '#src/utils/systemUtils.js';
import { defaultStatusCallback } from '#src/utils/consoleUtils.js';

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displaySuccess: vi.fn(),
    displayDebug: vi.fn(),
  };
});

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

function makeQuotaError(overrides: { message?: string; waitSec?: number; quotaId?: string } = {}) {
  const waitSec = overrides.waitSec ?? 51.386192716;
  const quotaId =
    overrides.quotaId ?? 'GenerateContentPaidTierInputTokensPerModelPerMinute-PaidTier2';
  const data = {
    error: {
      code: 429,
      message:
        overrides.message ??
        `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_2_input_token_count, limit: 3000000, model: gemini-3.8-flash\nPlease retry in ${waitSec}s.`,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric:
                'generativelanguage.googleapis.com/generate_content_paid_tier_2_input_token_count',
              quotaId,
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '14s' },
      ],
    },
  };
  const err = new Error(data.error.message) as Error & {
    name: string;
    statusCode: number;
    data: unknown;
  };
  err.name = 'RequestError';
  err.statusCode = 429;
  err.data = data;
  return err;
}

let toolRunCount = 0;
const testTool = tool(
  async () => {
    toolRunCount++;
    return 'TOOL_OUTPUT';
  },
  {
    name: 'testTool',
    description: 'A test tool.',
    schema: z.object({}),
  }
);

class ScriptedRunnerModel extends BaseChatModel {
  callCount = 0;
  requests: BaseMessage[][] = [];
  shouldCallToolFirst = false;
  quotaFailuresRemaining = 0;
  quotaErrorFactory = () => makeQuotaError();

  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted-runner-model';
  }
  bindTools(): unknown {
    return this;
  }
  async _generate(messages: BaseMessage[]) {
    this.requests.push(messages);
    this.callCount++;

    if (this.shouldCallToolFirst && !messages.some((m) => ToolMessage.isInstance(m))) {
      return {
        generations: [
          {
            message: new AIMessage({
              content: '',
              tool_calls: [{ name: 'testTool', args: {}, id: 'tool-call-1' }],
            }),
            text: '',
          },
        ],
      };
    }

    if (this.quotaFailuresRemaining > 0) {
      this.quotaFailuresRemaining--;
      throw this.quotaErrorFactory();
    }

    return {
      generations: [
        {
          message: new AIMessage('Success answer from model.'),
          text: 'Success answer from model.',
        },
      ],
    };
  }
}

const BASE_CONFIG = {
  streamOutput: true,
  contentSource: 'file',
  requirementSource: 'file',
  filesystem: 'none',
  useColour: false,
  writeOutputToFile: false,
  writeBinaryOutputsToFile: false,
  streamSessionInferenceLog: false,
  canInterruptInferenceWithEsc: false,
  includeCurrentDateAfterGuidelines: true,
};

describe('CFG-84 — GthAgentRunner quota cooldown reactive seam', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  const statusUpdate = vi.fn();

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    toolRunCount = 0;
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeRunner = async (model: ScriptedRunnerModel, extra: Record<string, unknown> = {}) => {
    const runner = new GthAgentRunner(statusUpdate, {
      resolveTools: vi.fn().mockResolvedValue([testTool]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = { ...BASE_CONFIG, ...extra, llm: model } as unknown as GthConfig;
    await runner.init('chat', config, new MemorySaver());
    return runner;
  };

  for (const streamOutput of [true, false]) {
    const driver = streamOutput ? 'streaming' : 'non-streaming';

    it(`completes the turn after cooling down from 429, waiting the parsed duration, and tool runs once (${driver})`, async () => {
      const model = new ScriptedRunnerModel();
      model.shouldCallToolFirst = true;
      model.quotaFailuresRemaining = 1;

      const runner = await makeRunner(model, { streamOutput });

      const turnPromise = runner.processMessages([new HumanMessage('Run tool and answer')]);

      // Allow the turn to progress to the wait
      await vi.advanceTimersByTimeAsync(100);

      // Verify the wait notice was emitted at StatusLevel.WARNING
      expect(statusUpdate).toHaveBeenCalledWith(
        StatusLevel.WARNING,
        "The provider's quota is exhausted; waiting 51 seconds before retrying."
      );

      // Tool has run exactly once before the model threw 429
      expect(toolRunCount).toBe(1);

      // Advance the remaining wait time (~51386 ms)
      await vi.advanceTimersByTimeAsync(52_000);

      const answer = await turnPromise;
      expect(answer).toBe('Success answer from model.');

      // Tool ran EXACTLY ONCE across the whole turn: the checkpoint resumed without re-running the tool
      expect(toolRunCount).toBe(1);

      // Model was called 3 times: call 1 (tool request), call 2 (429 throw), call 3 (answer after cooldown)
      expect(model.callCount).toBe(3);

      // Turn completed with no terminal rate_limited reason
      expect(runner.getTerminationReason()?.category).toBe('completed');
    });
  }

  it('terminates rate_limited when the wait exceeds the 90s bound', async () => {
    const model = new ScriptedRunnerModel();
    model.quotaFailuresRemaining = 1;
    // Set wait to 120 seconds (> 90s bound)
    model.quotaErrorFactory = () => makeQuotaError({ waitSec: 120 });

    const runner = await makeRunner(model, { streamOutput: true });

    let thrown: unknown;
    try {
      await runner.processMessages([new HumanMessage('Hello')]);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    // Did NOT emit the wait line
    expect(statusUpdate).not.toHaveBeenCalledWith(
      StatusLevel.WARNING,
      expect.stringContaining("The provider's quota is exhausted; waiting")
    );

    // Classified as rate_limited
    expect(runner.getTerminationReason()?.category).toBe('rate_limited');
    expect(model.callCount).toBe(1);
  });

  it('terminates rate_limited on a per-day quota', async () => {
    const model = new ScriptedRunnerModel();
    model.quotaFailuresRemaining = 1;
    model.quotaErrorFactory = () =>
      makeQuotaError({
        quotaId: 'GenerateContentPaidTierRequestsPerDay-PaidTier2',
        waitSec: 10,
      });

    const runner = await makeRunner(model, { streamOutput: true });

    let thrown: unknown;
    try {
      await runner.processMessages([new HumanMessage('Hello')]);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    // Did NOT emit the wait line
    expect(statusUpdate).not.toHaveBeenCalledWith(
      StatusLevel.WARNING,
      expect.stringContaining("The provider's quota is exhausted; waiting")
    );

    // Classified as rate_limited
    expect(runner.getTerminationReason()?.category).toBe('rate_limited');
    expect(model.callCount).toBe(1);
  });

  it('terminates rate_limited on a THIRD 429 in the same turn (maximum 2 cooldowns)', async () => {
    const model = new ScriptedRunnerModel();
    // Fails 3 times in a row with quota 429
    model.quotaFailuresRemaining = 3;

    const runner = await makeRunner(model, { streamOutput: true });

    const turnPromise = runner.processMessages([new HumanMessage('Hello')]);
    const thrownPromise = turnPromise.catch((e: unknown) => e);

    // First cooldown wait
    await vi.advanceTimersByTimeAsync(100);
    expect(statusUpdate).toHaveBeenCalledWith(
      StatusLevel.WARNING,
      "The provider's quota is exhausted; waiting 51 seconds before retrying."
    );
    await vi.advanceTimersByTimeAsync(52_000);

    // Second cooldown wait
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(52_000);

    // Third attempt fails, attempt limit (2) is reached, so it terminates
    const thrown = await thrownPromise;

    expect(thrown).toBeDefined();
    expect(runner.getTerminationReason()?.category).toBe('rate_limited');
    expect(model.callCount).toBe(3);
  });

  it('renders the wait line on a plain surface via defaultStatusCallback', async () => {
    const warnSpy = vi.spyOn(su, 'warn').mockImplementation(() => {});
    const model = new ScriptedRunnerModel();
    model.quotaFailuresRemaining = 1;

    // Construct runner with defaultStatusCallback (the plain surface callback)
    const runner = new GthAgentRunner(defaultStatusCallback, {
      resolveTools: vi.fn().mockResolvedValue([]),
      resolveMiddleware: async (m: unknown[] | undefined) => m ?? [],
    });
    const config = { ...BASE_CONFIG, llm: model } as unknown as GthConfig;
    await runner.init('chat', config, new MemorySaver());

    const turnPromise = runner.processMessages([new HumanMessage('Hello')]);
    await vi.advanceTimersByTimeAsync(100);

    // Check su.warn was called on the plain surface with the wait line
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("The provider's quota is exhausted; waiting 51 seconds before retrying.")
    );

    await vi.advanceTimersByTimeAsync(52_000);
    const answer = await turnPromise;
    expect(answer).toBe('Success answer from model.');
    warnSpy.mockRestore();
  });
});
