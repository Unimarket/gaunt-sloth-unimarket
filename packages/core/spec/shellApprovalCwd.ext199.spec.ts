/**
 * EXT-199 — Tests for shell command approvals with per-call cwd.
 *
 * Covers:
 *  - Rendering: approvalRequestRows and buildRaterPrompt text pinning for cwd and out-of-project
 *  - Refusal of invalid cwd (nonexistent or non-directory) before prompt / rating / execution
 *  - In-project grant coverage: grant for `pnpm test` covers `pnpm test` with cwd: packages/app
 *  - Out-of-project enforcement across all rungs (manual, write, assisted, auto) prompting even
 *    when a matching grant exists
 *  - Bypass rung runs out-of-project without prompting
 *  - Non-interactive escalation when no human callback is wired
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { peekProjectDir, setProjectDir, setStartupWorkDir } from '#src/utils/systemUtils.js';
import type {
  AgentStreamEvent,
  PendingToolInterrupt,
  ToolApprovalDecision,
} from '#src/core/types.js';
import type { GthConfig } from '#src/config.js';
import { approvalRequestRows } from '#src/core/approvals/approvalRequest.js';
import { buildRaterPrompt } from '#src/core/shell/rater.js';
import { AttackHaltError, NonInteractiveEscalationError } from '#src/core/shell/approvalStop.js';

const { rateShellCommandMock, mapVerdictToActionMock } = vi.hoisted(() => ({
  rateShellCommandMock: vi.fn(),
  mapVerdictToActionMock: vi.fn(),
}));
vi.mock('#src/core/shell/rater.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#src/core/shell/rater.js')>()),
  rateShellCommand: rateShellCommandMock,
  mapVerdictToAction: mapVerdictToActionMock,
}));

vi.mock('#src/utils/llmUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/llmUtils.js')>();
  return {
    ...actual,
    buildSystemMessages: vi.fn(() => [{ content: 'SYSTEM PROMPT' }]),
    readChatPrompt: vi.fn(() => 'chat-mode-prompt'),
    readCodePrompt: vi.fn(() => 'code-mode-prompt'),
    readExecPrompt: vi.fn(() => 'exec-mode-prompt'),
  };
});

vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return {
    ...actual,
    display: vi.fn(),
    displayInfo: vi.fn(),
    displaySuccess: vi.fn(),
    displayWarning: vi.fn(),
    displayError: vi.fn(),
    displayDebug: vi.fn(),
  };
});

interface ShellCallRequest {
  command: string;
  cwd?: string;
}

class ScriptedShellModel extends BaseChatModel {
  callCount = 0;
  private callSeq = 0;
  private readonly calls: ShellCallRequest[];

  constructor(calls: Array<ShellCallRequest | string>) {
    super({});
    this.calls = calls.map((c) => (typeof c === 'string' ? { command: c } : c));
  }

  _llmType(): string {
    return 'scripted-cwd';
  }

  bindTools(): unknown {
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    this.callCount++;
    const last = messages[messages.length - 1];
    const message = ToolMessage.isInstance(last)
      ? new AIMessage('final answer')
      : new AIMessage({
          content: '',
          tool_calls: [
            {
              name: 'run_shell_command',
              args: this.calls[Math.min(this.callSeq++, this.calls.length - 1)],
              id: `call-${this.callCount}`,
            },
          ],
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
}

describe('EXT-199 — Rendering text pinning', () => {
  const columns = 100;
  const projectRoot = '/mock/project/root';

  it('approvalRequestRows: omits cwd row when cwd is omitted', () => {
    const pending = {
      name: 'run_shell_command',
      args: { command: 'pnpm test' },
      subject: { kind: 'shell', command: 'pnpm test' },
    } as unknown as PendingToolInterrupt;

    const rows = approvalRequestRows(pending, { columns });
    const cwdRow = rows.find((r) => r.text.includes('Working directory:'));
    expect(cwdRow).toBeUndefined();
  });

  it('approvalRequestRows: renders Working directory with chrome tone when cwd is inside project', () => {
    const inProjectCwd = path.join(projectRoot, 'packages', 'app');
    const pending = {
      name: 'run_shell_command',
      args: { command: 'pnpm test', cwd: 'packages/app' },
      subject: { kind: 'shell', command: 'pnpm test' },
      cwd: inProjectCwd,
    } as unknown as PendingToolInterrupt;

    const rows = approvalRequestRows(pending, { columns });
    const cwdRow = rows.find((r) => r.text.includes('Working directory:'));
    expect(cwdRow).toBeDefined();
    expect(cwdRow?.tone).toBe('chrome');
    expect(cwdRow?.text).toBe(`Working directory: ${inProjectCwd}`);
    expect(cwdRow?.text).not.toContain('outside project');
  });

  it('approvalRequestRows: renders both directories with warn tone when cwd is outside project', () => {
    const outsideCwd = '/var/outside/dir';
    const pending = {
      name: 'run_shell_command',
      args: { command: 'rm -rf x', cwd: outsideCwd },
      subject: { kind: 'shell', command: 'rm -rf x' },
      cwd: outsideCwd,
      projectDir: projectRoot,
    } as unknown as PendingToolInterrupt;

    const rows = approvalRequestRows(pending, { columns });
    const cwdRow = rows.find((r) => r.text.includes('Working directory:'));
    expect(cwdRow).toBeDefined();
    expect(cwdRow?.tone).toBe('warn');
    expect(cwdRow?.text).toBe(`Working directory: ${outsideCwd} (outside project: ${projectRoot})`);
  });

  it('buildRaterPrompt: omits cwd line when cwd is omitted', () => {
    const { user } = buildRaterPrompt('pnpm test');
    expect(user).not.toContain('Working directory:');
  });

  it('buildRaterPrompt: names resolved cwd when inside project', () => {
    const inProjectCwd = path.join(projectRoot, 'packages', 'app');
    const { user } = buildRaterPrompt('pnpm test', { cwd: inProjectCwd });
    expect(user).toContain(`Working directory: ${inProjectCwd}`);
    expect(user).not.toContain('outside project');
  });

  it('buildRaterPrompt: names both directories when cwd is outside project', () => {
    const outsideCwd = '/var/outside/dir';
    const { user } = buildRaterPrompt('rm -rf x', { cwd: outsideCwd, projectDir: projectRoot });
    expect(user).toContain(`Working directory: ${outsideCwd} (outside project: ${projectRoot})`);
  });
});

describe('EXT-199 — GthAgentRunner approval gate with cwd', () => {
  let GthAgentRunner: typeof import('#src/core/GthAgentRunner.js').GthAgentRunner;
  let executed: Array<{ command: string; cwd?: string }>;
  let tempBase: string;
  let projectDir: string;
  let outsideDir: string;
  let priorProjectDir: string | undefined;
  let priorInitCwd: string | undefined;

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

  beforeEach(async () => {
    vi.resetAllMocks();
    tempBase = realpathSync(mkdtempSync(path.join(tmpdir(), 'ext199-gate-spec-')));
    projectDir = path.join(tempBase, 'project');
    outsideDir = path.join(tempBase, 'outside');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    priorProjectDir = peekProjectDir();
    priorInitCwd = process.env.INIT_CWD;
    process.env.INIT_CWD = projectDir;
    setProjectDir(projectDir);
    setStartupWorkDir(projectDir);

    executed = [];
    ({ GthAgentRunner } = await import('#src/core/GthAgentRunner.js'));
  });

  afterEach(() => {
    setProjectDir(priorProjectDir);
    setStartupWorkDir(undefined);
    if (priorInitCwd !== undefined) {
      process.env.INIT_CWD = priorInitCwd;
    } else {
      delete process.env.INIT_CWD;
    }
  });

  afterAll(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  const makeShellTool = () =>
    tool(
      async (args: { command: string; cwd?: string }) => {
        executed.push(args);
        return `ran: ${args.command}`;
      },
      {
        name: 'run_shell_command',
        description: 'Run a shell command.',
        schema: z.object({ command: z.string(), cwd: z.string().optional() }),
      }
    );

  const makeRunner = async (
    calls: Array<ShellCallRequest | string>,
    configExtra: Partial<GthConfig> = {},
    status: (level: any, message: string) => void = vi.fn()
  ) => {
    const runner = new GthAgentRunner(status);
    const model = new ScriptedShellModel(calls);
    const shellTool = makeShellTool();
    const config = {
      ...BASE_CONFIG,
      llm: model,
      devTools: { run_shell_command: { enabled: true } },
      tools: [shellTool],
      approvals: 'manual',
      ...configExtra,
    } as unknown as GthConfig;
    await runner.init('code', config, new MemorySaver());
    return runner;
  };

  const runTurn = async (
    runner: InstanceType<typeof GthAgentRunner>,
    prompt: string
  ): Promise<AgentStreamEvent[]> => {
    const events: AgentStreamEvent[] = [];
    for await (const ev of runner.processMessagesWithEvents([new HumanMessage(prompt)])) {
      events.push(ev);
    }
    return events;
  };

  it('refuses nonexistent cwd immediately with invalid-cwd stage and runs nothing', async () => {
    const runner = await makeRunner([{ command: 'ls', cwd: 'nonexistent/sub' }]);
    const human = vi.fn();
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'list');

    expect(human).not.toHaveBeenCalled();
    expect(rateShellCommandMock).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);

    const snapshot = runner.getApprovalCaptures();
    const lastRecord = snapshot[snapshot.length - 1];
    expect(lastRecord.stage).toBe('invalid-cwd');
    expect(lastRecord.action).toBe('reject');
  });

  it('refuses non-directory cwd immediately with invalid-cwd stage and runs nothing', async () => {
    const filePath = path.join(projectDir, 'test.txt');
    writeFileSync(filePath, 'hello');

    const runner = await makeRunner([{ command: 'ls', cwd: 'test.txt' }]);
    const human = vi.fn();
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'list');

    expect(human).not.toHaveBeenCalled();
    expect(rateShellCommandMock).not.toHaveBeenCalled();
    expect(executed).toHaveLength(0);

    const snapshot = runner.getApprovalCaptures();
    const lastRecord = snapshot[snapshot.length - 1];
    expect(lastRecord.stage).toBe('invalid-cwd');
    expect(lastRecord.action).toBe('reject');
  });

  it('in-project: grant for pnpm test covers pnpm test with cwd: packages/app without prompting', async () => {
    const subDir = path.join(projectDir, 'packages', 'app');
    mkdirSync(subDir, { recursive: true });

    // Grant pnpm test in config
    const runner = await makeRunner([{ command: 'pnpm test', cwd: 'packages/app' }], {
      approvals: {
        mode: 'manual',
        allow: [{ type: 'shell', matcher: 'exact', pattern: 'pnpm test' }],
      },
    } as unknown as Partial<GthConfig>);

    const human = vi.fn();
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run tests');

    // Inside project: allow rule matches, so no human prompt is asked
    expect(human).not.toHaveBeenCalled();
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe('pnpm test');
  });

  it('out-of-project: at manual rung, prompts human even when matching grant exists', async () => {
    const runner = await makeRunner([{ command: 'pnpm test', cwd: outsideDir }], {
      approvals: {
        mode: 'manual',
        allow: [{ type: 'shell', matcher: 'exact', pattern: 'pnpm test' }],
      },
    } as unknown as Partial<GthConfig>);

    let promptedPending: PendingToolInterrupt | undefined;
    const human = vi.fn(async (pending: PendingToolInterrupt): Promise<ToolApprovalDecision> => {
      promptedPending = pending;
      return { type: 'approve', scope: 'once' };
    });
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run tests');

    expect(human).toHaveBeenCalledTimes(1);
    expect(promptedPending?.cwd).toBe(realpathSync(outsideDir));
    expect(promptedPending?.projectDir).toBe(realpathSync(projectDir));
    expect(executed).toHaveLength(1);
  });

  it('out-of-project: at write rung, prompts human even when matching grant exists', async () => {
    const runner = await makeRunner([{ command: 'pnpm test', cwd: outsideDir }], {
      approvals: {
        mode: 'write',
        allow: [{ type: 'shell', matcher: 'exact', pattern: 'pnpm test' }],
      },
    } as unknown as Partial<GthConfig>);

    const human = vi.fn(async (): Promise<ToolApprovalDecision> => ({
      type: 'approve',
      scope: 'once',
    }));
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run tests');

    expect(human).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(1);
  });

  it('out-of-project: at assisted rung, prompts human even when rater returns safe and grant exists', async () => {
    const verdict = { outcome: 'safe', reason: 'safe command' };
    rateShellCommandMock.mockResolvedValue(verdict);
    mapVerdictToActionMock.mockReturnValue({ action: 'approve', verdict });

    const runner = await makeRunner([{ command: 'pnpm test', cwd: outsideDir }], {
      approvals: {
        mode: 'assisted',
        allow: [{ type: 'shell', matcher: 'exact', pattern: 'pnpm test' }],
      },
    } as unknown as Partial<GthConfig>);

    const human = vi.fn(async (): Promise<ToolApprovalDecision> => ({
      type: 'approve',
      scope: 'once',
    }));
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run tests');

    // Out of project requires human confirmation despite safe rating and matching grant
    expect(human).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(1);
  });

  it('out-of-project: at auto rung, prompts human without auto-negotiation or auto-approval', async () => {
    const verdict = { outcome: 'safe', reason: 'safe command' };
    rateShellCommandMock.mockResolvedValue(verdict);
    mapVerdictToActionMock.mockReturnValue({ action: 'approve', verdict });

    const runner = await makeRunner([{ command: 'pnpm test', cwd: outsideDir }], {
      approvals: {
        mode: 'auto',
        allow: [{ type: 'shell', matcher: 'exact', pattern: 'pnpm test' }],
      },
    } as unknown as Partial<GthConfig>);

    const human = vi.fn(async (): Promise<ToolApprovalDecision> => ({
      type: 'approve',
      scope: 'once',
    }));
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run tests');

    // Out of project at auto prompts human for confirmation
    expect(human).toHaveBeenCalledTimes(1);
    expect(executed).toHaveLength(1);
  });

  it('out-of-project: at bypass rung, runs without prompting', async () => {
    const runner = await makeRunner([{ command: 'pnpm test', cwd: outsideDir }], {
      approvals: {
        mode: 'bypass',
      },
    } as unknown as Partial<GthConfig>);

    const human = vi.fn();
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run tests');

    // Bypass runs directly without prompting
    expect(human).not.toHaveBeenCalled();
    expect(executed).toHaveLength(1);
    expect(executed[0].command).toBe('pnpm test');
  });

  it('out-of-project escape vectors: .. traversal, symlink to outside, and absolute path all prompt', async () => {
    // 1. .. traversal
    const upDir = '../outside';
    // 2. symlink
    const linkPath = path.join(projectDir, 'symlink-outside');
    symlinkSync(outsideDir, linkPath, 'junction');

    const runner = await makeRunner(
      [
        { command: 'echo traversal', cwd: upDir },
        { command: 'echo symlink', cwd: 'symlink-outside' },
      ],
      {
        approvals: {
          mode: 'manual',
          allow: [
            { type: 'shell', matcher: 'exact', pattern: 'echo traversal' },
            { type: 'shell', matcher: 'exact', pattern: 'echo symlink' },
          ],
        },
      } as unknown as Partial<GthConfig>
    );

    const human = vi.fn(async (): Promise<ToolApprovalDecision> => ({
      type: 'approve',
      scope: 'once',
    }));
    runner.setToolApprovalCallback(human);

    await runTurn(runner, 'run first');
    expect(human).toHaveBeenCalledTimes(1);

    await runTurn(runner, 'run second');
    expect(human).toHaveBeenCalledTimes(2);
  });

  it('out-of-project: non-interactive run throws NonInteractiveEscalationError', async () => {
    const runner = await makeRunner([{ command: 'pnpm test', cwd: outsideDir }], {
      approvals: {
        mode: 'manual',
      },
    } as unknown as Partial<GthConfig>);

    // No toolApprovalCallback wired
    const error = await runTurn(runner, 'run tests')
      .then(() => null)
      .catch((e: unknown) => e as Error);

    expect(error).toBeInstanceOf(NonInteractiveEscalationError);
    expect(executed).toHaveLength(0);
  });

  /**
   * [[EXT-201]] — end to end through the runner: the stop with nobody to ask names the directory
   * as the reason, keeps the `safe` rating, and offers no allow entry — even with the exact entry
   * the old message suggested already configured, which is the measured case. Every escape vector.
   * Directories compare against `realpathSync` values, never POSIX literals (the Windows cell).
   */
  const catchTurn = (runner: InstanceType<typeof GthAgentRunner>, prompt: string) =>
    runTurn(runner, prompt)
      .then(() => null)
      .catch((e: unknown) => e as Error);

  const valueOf = (error: { parts: readonly any[] }, label: string): string | undefined =>
    error.parts.find((part) => part.kind === 'value' && part.label === label)?.text;

  const OUT_OF_PROJECT_CAUSE = "The command's working directory is outside the project";

  it.each([
    ['an absolute path', () => outsideDir],
    ['a .. traversal', () => '../outside'],
    [
      'a symlink pointing outside',
      () => {
        symlinkSync(outsideDir, path.join(projectDir, 'link-out'), 'junction');
        return 'link-out';
      },
    ],
  ])(
    'EXT-201: auto, rated safe, %s: names both directories and offers no allow entry',
    async (_name, cwdFor) => {
      const verdict = { outcome: 'safe', reason: 'Read-only inspection of a local text file.' };
      rateShellCommandMock.mockResolvedValue(verdict);
      mapVerdictToActionMock.mockReturnValue({ action: 'approve', verdict });

      const runner = await makeRunner([{ command: 'cat marker.txt', cwd: cwdFor() }], {
        approvals: {
          mode: 'auto',
          allow: [{ type: 'shell', matcher: 'exact', pattern: 'cat marker.txt' }],
        },
      } as unknown as Partial<GthConfig>);

      const error = await catchTurn(runner, 'read it');

      expect(error).toBeInstanceOf(NonInteractiveEscalationError);
      const stop = error as NonInteractiveEscalationError;
      expect(executed).toHaveLength(0);
      expect(stop.outcome).toBe('safe');
      expect(valueOf(stop, 'Rating')).toBe('safe');
      expect(valueOf(stop, 'Working directory')).toBe(realpathSync(outsideDir));
      expect(valueOf(stop, 'Project directory')).toBe(realpathSync(projectDir));
      expect(stop.message).toContain(OUT_OF_PROJECT_CAUSE);
      expect(valueOf(stop, 'approvals.allow entry')).toBeUndefined();
      expect(stop.allowEntry).toBeUndefined();
      expect(stop.message).not.toContain('"pattern": "cat marker.txt"');
      expect(stop.message).not.toContain('Declare the commands this run is allowed to execute');
    }
  );

  it('EXT-201: an in-project stop with nobody to ask still offers the specific allow entry', async () => {
    mkdirSync(path.join(projectDir, 'packages', 'app'), { recursive: true });
    const runner = await makeRunner([{ command: 'cat marker.txt', cwd: 'packages/app' }], {
      approvals: { mode: 'manual' },
    } as unknown as Partial<GthConfig>);

    const error = await catchTurn(runner, 'read it');

    expect(error).toBeInstanceOf(NonInteractiveEscalationError);
    const stop = error as NonInteractiveEscalationError;
    expect(stop.outOfProject).toBeUndefined();
    expect(valueOf(stop, 'approvals.allow entry')).toBe(
      '{ "type": "shell", "matcher": "exact", "pattern": "cat marker.txt" }'
    );
    expect(stop.message).not.toContain(OUT_OF_PROJECT_CAUSE);
  });

  /**
   * [[EXT-201]] — the out-of-project rewrite to `escalate` spares a halt, so an `attack` rating on
   * an out-of-project call DOES reach `AttackHaltError`; its allow-list recovery must not appear.
   */
  it('EXT-201: an out-of-project attack halts naming both directories, without the allow-list recovery', async () => {
    const verdict = { outcome: 'attack', reason: 'hides what it runs' };
    rateShellCommandMock.mockResolvedValue(verdict);
    mapVerdictToActionMock.mockReturnValue({ action: 'halt', verdict });

    const runner = await makeRunner([{ command: 'cat marker.txt', cwd: outsideDir }], {
      approvals: { mode: 'auto' },
    } as unknown as Partial<GthConfig>);

    const error = await catchTurn(runner, 'read it');

    expect(error).toBeInstanceOf(AttackHaltError);
    const halt = error as AttackHaltError;
    expect(executed).toHaveLength(0);
    expect(valueOf(halt, 'Working directory')).toBe(realpathSync(outsideDir));
    expect(valueOf(halt, 'Project directory')).toBe(realpathSync(projectDir));
    expect(halt.message).toContain(OUT_OF_PROJECT_CAUSE);
    expect(halt.message).not.toContain('declare it in approvals.allow — that list is consulted');
  });

  it('EXT-201: an in-project attack keeps the allow-list recovery', async () => {
    const verdict = { outcome: 'attack', reason: 'hides what it runs' };
    rateShellCommandMock.mockResolvedValue(verdict);
    mapVerdictToActionMock.mockReturnValue({ action: 'halt', verdict });

    const runner = await makeRunner([{ command: 'cat marker.txt', cwd: '.' }], {
      approvals: { mode: 'auto' },
    } as unknown as Partial<GthConfig>);

    const error = await catchTurn(runner, 'read it');

    expect(error).toBeInstanceOf(AttackHaltError);
    const halt = error as AttackHaltError;
    expect(halt.outOfProject).toBeUndefined();
    expect(halt.message).toContain('declare it in approvals.allow — that list is consulted');
    expect(halt.message).not.toContain(OUT_OF_PROJECT_CAUSE);
  });

  /**
   * [[EXT-201]] m3 — the same halt at `assisted`, with the REAL `mapVerdictToAction`, so the
   * attack-to-halt mapping this lane's trace rests on is exercised rather than scripted. Set in the
   * test body because `beforeEach` resets every mock implementation.
   */
  it('EXT-201: assisted, real verdict mapping: an out-of-project attack halts', async () => {
    const actual = await vi.importActual<typeof import('#src/core/shell/rater.js')>(
      '#src/core/shell/rater.js'
    );
    mapVerdictToActionMock.mockImplementation(actual.mapVerdictToAction);
    rateShellCommandMock.mockResolvedValue({ outcome: 'attack', reason: 'hides what it runs' });

    const runner = await makeRunner([{ command: 'cat marker.txt', cwd: outsideDir }], {
      approvals: { mode: 'assisted' },
    } as unknown as Partial<GthConfig>);

    const error = await catchTurn(runner, 'read it');

    expect(error).toBeInstanceOf(AttackHaltError);
    const halt = error as AttackHaltError;
    expect(executed).toHaveLength(0);
    expect(valueOf(halt, 'Working directory')).toBe(realpathSync(outsideDir));
    expect(halt.message).toContain(OUT_OF_PROJECT_CAUSE);
    expect(halt.message).toContain('run it in an interactive session');
  });

  /**
   * [[EXT-201]] — the out-of-project halt tells the reader an interactive session can get past it.
   * That is true only because the banner is offered with no project check; this pins it.
   */
  it('EXT-201: an out-of-project attack is offered the banner, and run anyway runs it once', async () => {
    const verdict = { outcome: 'attack', reason: 'hides what it runs' };
    rateShellCommandMock.mockResolvedValue(verdict);
    mapVerdictToActionMock.mockReturnValue({ action: 'halt', verdict });

    const runner = await makeRunner([{ command: 'cat marker.txt', cwd: outsideDir }], {
      approvals: { mode: 'auto' },
    } as unknown as Partial<GthConfig>);
    const banner = vi.fn(() => 'run-anyway' as const);
    runner.setAttackHaltCallback(banner);

    const error = await catchTurn(runner, 'read it');

    expect(error).toBeNull();
    expect(banner).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([{ command: 'cat marker.txt', cwd: outsideDir }]);
  });
});
