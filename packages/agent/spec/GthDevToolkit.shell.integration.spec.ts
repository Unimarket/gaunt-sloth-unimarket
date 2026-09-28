/**
 * Integration tests for the EXT-9 Tier-1 shell hardening. These run REAL shell
 * commands (no child_process mock) on a POSIX host, exercising the spawn-path
 * behavior: timeout + process-group kill, stdin-closed, output cap + temp-file
 * spillover, credential env scrub, and the unbypassable hardline blocklist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CommandEnvPolicy } from '#src/tools/shell/env.js';

// Keep terminal noise out of the test output but let env (real process.env)
// flow through so the credential-scrub test is meaningful.
vi.mock('#src/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
}));
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return { ...actual, stdout: { write: vi.fn() } };
});

const isPosix = process.platform !== 'win32';
const d = isPosix ? describe : describe.skip;

d('GthDevToolkit shell hardening (real spawn)', () => {
  let GthDevToolkit: typeof import('#src/tools/GthDevToolkit.js').default;

  beforeEach(async () => {
    ({ default: GthDevToolkit } = await import('#src/tools/GthDevToolkit.js'));
  });

  afterEach(() => {
    delete process.env.GSLOTH_FAKE_ANTHROPIC_PROBE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.EXT126_FIXTURE_SECRET;
    delete process.env.EXT126_FIXTURE_TOKEN;
  });

  // Helper: invoke the private executeCommand with a given dev-tools config.
  const run = (command: string, commands = {}) => {
    const toolkit = new GthDevToolkit(commands);
    return (
      toolkit as unknown as { executeCommand(_c: string, _n: string): Promise<string> }
    ).executeCommand(command, 'run_shell_command');
  };

  /** EXT-125: the same, with a per-call time budget attached to THIS invocation. */
  const runWithBudget = (command: string, commands: object, timeoutMs: number) => {
    const toolkit = new GthDevToolkit(commands);
    return (
      toolkit as unknown as {
        executeCommand(_c: string, _n: string, _id?: string, _t?: number): Promise<string>;
      }
    ).executeCommand(command, 'run_shell_command', undefined, timeoutMs);
  };

  /** EXT-199: the same, with a per-call cwd attached to THIS invocation. */
  const runWithCwd = (command: string, commands: object, cwd: string) => {
    const toolkit = new GthDevToolkit(commands);
    return (
      toolkit as unknown as {
        executeCommand(
          _c: string,
          _n: string,
          _id?: string,
          _t?: number,
          _cwd?: string
        ): Promise<string>;
      }
    ).executeCommand(command, 'run_shell_command', undefined, undefined, cwd);
  };

  it('kills a long-running command after the configured timeout (throws, preserving the body)', async () => {
    const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
    const start = Date.now();
    // EXT-20: a timeout-kill now REJECTS with ShellCommandFailedError (exitCode null) so the
    // softening middleware renders ✗; the killed-after-N message is preserved on the error.
    const error = await run('sleep 30', { shell: { enabled: true, timeout: 300 } }).catch(
      (e) => e as InstanceType<typeof ShellCommandFailedError>
    );
    const elapsed = Date.now() - start;
    expect(error).toBeInstanceOf(ShellCommandFailedError);
    expect(error.exitCode).toBeNull();
    // EXT-125: the kill names the budget it hit, in ms.
    expect(error.output).toContain('300ms time budget');
    // Should be killed quickly (well before sleep 30 finishes).
    expect(elapsed).toBeLessThan(10_000);
  }, 15_000);

  it('does not hang on a command that would read stdin (stdin is closed)', async () => {
    // `cat` with no args reads stdin; with stdin=ignore it gets EOF and exits.
    const result = await run('cat', { shell: { enabled: true, timeout: 5000 } });
    expect(result).toContain('completed successfully');
  }, 10_000);

  it('caps output and spills the full output to a temp file', async () => {
    // Print ~50KB; cap at 2KB so it must truncate.
    const result = await run('for i in $(seq 1 2000); do echo "line-$i-padding-xxxxxxxxxx"; done', {
      shell: { enabled: true, maxOutputBytes: 2000 },
    });
    expect(result).toContain('output truncated');
    expect(result).toContain('read_file');
    const match = result.match(/Full output written to (\S+\.log)/);
    expect(match).not.toBeNull();
    const onDisk = readFileSync(match![1], 'utf8');
    // The spilled file holds far more than the 2KB preview budget.
    expect(onDisk.length).toBeGreaterThan(10_000);
    expect(onDisk).toContain('line-2000-padding');
  }, 15_000);

  /** EXT-126: the same, with a resolved `commandEnv` policy handed to the toolkit. */
  const runWithEnv = (command: string, commands: object, commandEnv?: CommandEnvPolicy) => {
    const toolkit = new GthDevToolkit(commands, undefined, commandEnv);
    return (
      toolkit as unknown as { executeCommand(_c: string, _n: string): Promise<string> }
    ).executeCommand(command, 'run_shell_command');
  };

  // EXT-126: scrubbing is opt-in. Fixture values only — never a real key.
  const PROBE = 'printf "SECRET=[%s]|TOKEN=[%s]" "$EXT126_FIXTURE_SECRET" "$EXT126_FIXTURE_TOKEN"';
  const shellOn = { shell: { enabled: true, timeout: 5000 } };

  it('scrubbing off (default): a credential reaches the child env', async () => {
    process.env.EXT126_FIXTURE_SECRET = 'fixture-secret-EXT126';
    process.env.EXT126_FIXTURE_TOKEN = 'fixture-token-EXT126';
    const result = await runWithEnv(PROBE, shellOn);
    expect(result).toContain('SECRET=[fixture-secret-EXT126]|TOKEN=[fixture-token-EXT126]');
  }, 10_000);

  it('scrubbing on: a credential is removed from the child env', async () => {
    process.env.EXT126_FIXTURE_SECRET = 'fixture-secret-EXT126';
    process.env.EXT126_FIXTURE_TOKEN = 'fixture-token-EXT126';
    const result = await runWithEnv(PROBE, shellOn, { scrubCredentials: true, passthrough: [] });
    expect(result).toContain('SECRET=[]|TOKEN=[]');
    expect(result).not.toContain('fixture-secret-EXT126');
    expect(result).not.toContain('fixture-token-EXT126');
  }, 10_000);

  it('scrubbing on with passthrough: keeps exactly the named variable, removes the rest', async () => {
    process.env.EXT126_FIXTURE_SECRET = 'fixture-secret-EXT126';
    process.env.EXT126_FIXTURE_TOKEN = 'fixture-token-EXT126';
    const result = await runWithEnv(PROBE, shellOn, {
      scrubCredentials: true,
      passthrough: ['EXT126_FIXTURE_TOKEN'],
    });
    expect(result).toContain('SECRET=[]|TOKEN=[fixture-token-EXT126]');
  }, 10_000);

  it('scrubbing on: a non-zero exit names the removed variables, never their values', async () => {
    const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
    process.env.EXT126_FIXTURE_SECRET = 'fixture-secret-EXT126';
    const error = await runWithEnv(`${PROBE}; exit 4`, shellOn, {
      scrubCredentials: true,
      passthrough: [],
    }).catch((e) => e as InstanceType<typeof ShellCommandFailedError>);
    expect(error).toBeInstanceOf(ShellCommandFailedError);
    expect(error.exitCode).toBe(4);
    const line = error.output.split('\n').find((l) => l.includes('commandEnv.scrubCredentials'));
    expect(line).toBeDefined();
    expect(line).toContain('EXT126_FIXTURE_SECRET');
    expect(error.output).not.toContain('fixture-secret-EXT126');
  }, 10_000);

  it('scrubbing off: a non-zero exit carries no scrub line', async () => {
    const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
    const error = await runWithEnv('exit 4', shellOn).catch(
      (e) => e as InstanceType<typeof ShellCommandFailedError>
    );
    expect(error).toBeInstanceOf(ShellCommandFailedError);
    expect(error.output).toContain('exited with code 4');
    expect(error.output).not.toContain('commandEnv.scrubCredentials');
  }, 10_000);

  it('preserves generic env (PATH) for the child', async () => {
    const result = await run('test -n "$PATH" && echo HAVE_PATH', {
      shell: { enabled: true, timeout: 5000 },
    });
    expect(result).toContain('HAVE_PATH');
  }, 10_000);

  it('refuses a hardline command WITHOUT executing, even under approvals bypass', async () => {
    // CFG-26 — `approvals.mode: "bypass"` skips confirmation but must NOT bypass the hardline
    // floor. The floor lives in executeCommand, so no approval config can reach past it: the
    // toolkit is not even told which mode is in force.
    const result = await run('rm -rf /', {
      shell: { enabled: true },
    });
    expect(result).toContain('blocked by hardline safety policy');
    expect(result).toContain('even when command confirmation is disabled');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
  });

  it('refuses a hardline command at exec time regardless of HOW it was approved (CFG-26 modes)', async () => {
    // The session approval mode only changes the APPROVAL decision (approve without prompting) in
    // GthAgentRunner; the tool body is unchanged, so the unbypassable hardline floor still fires
    // at exec time exactly as it does under a config-set bypass. This asserts the floor is a
    // property of executeCommand itself, not of any particular approval path.
    const result = await run('mkfs.ext4 /dev/sda', { shell: { enabled: true } });
    expect(result).toContain('blocked by hardline safety policy');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
  });

  it('refuses an OBFUSCATED hardline command (normalization works)', async () => {
    const result = await run('r\\m -rf /', { shell: { enabled: true } });
    expect(result).toContain('blocked by hardline safety policy');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
  });

  it('still runs a benign command normally', async () => {
    const result = await run('echo hello-world', { shell: { enabled: true } });
    expect(result).toContain('hello-world');
    expect(result).toContain('completed successfully');
  }, 10_000);

  // ---------------------------------------------------------------------------------------------
  // EXT-125 — the per-call budget, exercised against a REAL process rather than a timer mock.
  // ---------------------------------------------------------------------------------------------

  it('EXT-125: a killed command returns the output it produced BEFORE the kill', async () => {
    const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
    // Prints, flushes, then hangs. The kill must not discard the marker: that output is usually
    // the only evidence of how far a long command actually got.
    const error = await run('echo pre-kill-marker; sleep 30', {
      shell: { enabled: true, timeout: 500 },
    }).catch((e) => e as InstanceType<typeof ShellCommandFailedError>);
    expect(error).toBeInstanceOf(ShellCommandFailedError);
    expect(error.output).toContain('pre-kill-marker');
    expect(error.output).toContain('500ms time budget');
  }, 15_000);

  it('EXT-125: a per-call budget is honoured end to end, below the configured default', async () => {
    const { ShellCommandFailedError } = await import('#src/tools/GthDevToolkit.js');
    const start = Date.now();
    // Config would give this 30s; the CALL asks for 400ms and gets it, so the kill lands early.
    const error = await runWithBudget(
      'sleep 30',
      { shell: { enabled: true, timeout: 30_000 } },
      400
    ).catch((e) => e as InstanceType<typeof ShellCommandFailedError>);
    expect(error).toBeInstanceOf(ShellCommandFailedError);
    expect(error.output).toContain('400ms time budget');
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 20_000);

  it('EXT-125: a budget above the ceiling never reaches a process', async () => {
    // `sleep 30` would take 30s if it ran at all; the refusal returns immediately and the elapsed
    // time is the evidence that nothing was spawned, independently of the message.
    const start = Date.now();
    const result = await runWithBudget(
      'sleep 30',
      { shell: { enabled: true, maxTimeout: 1_000, timeout: 1_000 } },
      60_000
    );
    expect(result).toContain('No command was executed');
    expect(result).toContain('1000ms');
    expect(result).not.toContain('<COMMAND_OUTPUT>');
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 15_000);

  // ---------------------------------------------------------------------------------------------
  // EXT-199 — the per-call cwd, exercised against a REAL process rather than a spawn mock.
  // ---------------------------------------------------------------------------------------------

  it('EXT-199: cwd runs the command in that directory and relative path resolves against workDir', async () => {
    const result = await runWithCwd('pwd', { shell: { enabled: true } }, 'packages/app');
    expect(result).toContain('completed successfully');
    expect(result).toContain('packages/app');
  }, 10_000);
});
