/**
 * @module GthDevToolkit
 */
import { BaseToolkit, StructuredToolInterface, tool } from '@langchain/core/tools';
import type { ToolRunnableConfig } from '@langchain/core/tools';
import { z } from 'zod';
import { spawn, spawnSync } from 'child_process';
import path from 'node:path';
// TUI-C31 (a): failure-path warnings/errors travel the tool-output channel (see emitToolOutput
// below) so they reach the managed frame under the Ink TUI instead of raw stdout; the channel's
// default sink still renders them via displayWarning/displayError for every headless surface.
import {
  GthDevToolsConfig,
  getShellMaxOutputBytes,
  getShellMaxTimeoutMs,
  getShellTimeoutMs,
  isShellToolEnabled,
} from '@gaunt-sloth/core/config.js';
import type { GthCommand } from '@gaunt-sloth/core/core/types.js';
import { emitToolOutput } from '@gaunt-sloth/core/core/toolOutputChannel.js';
import { ShellCommandFailedError } from '@gaunt-sloth/core/core/shell/ShellCommandFailedError.js';
import { buildHardlineRefusal, checkHardline } from '@gaunt-sloth/core/core/shell/hardline.js';
import { buildScrubbedEnv } from '#src/tools/shell/env.js';
import { OutputBuffer } from '#src/tools/shell/outputBuffer.js';
import { getShellWorkDir, resolveShellCwd } from '#src/tools/shell/workDir.js';

// EXT-21: `ShellCommandFailedError` lives in core so any agent can recognise a shell failure
// without breaking the agent→core dependency direction (the lean `GthLangChainAgent` lives in core
// and cannot import from agent). Re-exported here so `#src/tools/GthDevToolkit.js` importers
// resolve it too, and every throw below is one and the same core type the softener catches.
export { ShellCommandFailedError } from '@gaunt-sloth/core/core/shell/ShellCommandFailedError.js';

// Grace period (ms) between SIGTERM and the escalation to SIGKILL when a command
// exceeds its timeout. Mirrors opencode's `forceKillAfter` (3s).
const KILL_GRACE_MS = 3_000;

/**
 * Kill the child AND its descendants on timeout.
 *
 * POSIX: the child is spawned `detached`, so it leads its own process group;
 * signalling the NEGATIVE pid (`-pid`) delivers to the whole group — otherwise a
 * shell's children (e.g. a spawned server) would be orphaned and keep running.
 *
 * Windows (EXT-15): there are no POSIX process groups — `process.kill(-pid)`
 * throws `EINVAL`, and `child.kill()` only terminates the `cmd.exe` wrapper while
 * grandchildren keep the piped stdio handles open, so `'close'` never fires and
 * the tool Promise hangs forever (silently cancelling Windows CI). Use `taskkill
 * /T` to kill the whole tree by pid; `/F` (force) mirrors POSIX SIGKILL, while a
 * graceful taskkill mirrors SIGTERM. Swallows the races where it has already exited.
 *
 * Exported for unit testing the platform branch without a Windows host.
 */
export function killProcessGroup(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  signal: NodeJS.Signals
): void {
  if (typeof child.pid !== 'number') return;

  if (process.platform === 'win32') {
    // No process groups on Windows; taskkill /T walks the whole tree by pid.
    const args = ['/PID', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    // IMPORTANT: spawnSync does NOT throw when it fails to spawn (e.g. ENOENT if taskkill is
    // missing from PATH) — unlike execSync, it returns an object with an `error` property. So a
    // try/catch would never reach the fallback. Inspect `res.error` explicitly and fall back to
    // the direct child kill (best effort). A non-zero exit (process already gone) is NOT a spawn
    // failure, so it correctly does not trigger the fallback. (`res?.` tolerates test mocks.)
    const res = spawnSync('taskkill', args, { stdio: 'ignore', windowsHide: true });
    if (res?.error) {
      try {
        child.kill(signal);
      } catch {
        // Already exited — nothing to do.
      }
    }
    return;
  }

  try {
    // Negative pid → signal the entire process group.
    process.kill(-child.pid, signal);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // ESRCH: already gone. EPERM: group-kill not permitted — fall through to the
    // direct child kill below. Anything else: also fall back rather than throw.
    if (code === 'ESRCH') return;
  }
  // Fallback: kill just the child (best effort).
  try {
    child.kill(signal);
  } catch {
    // Already exited — nothing to do.
  }
}

/**
 * [[EXT-125]] — the outcome of resolving ONE call's time budget, before anything is spawned.
 *
 * A discriminated union rather than a number plus an out-of-band error, because the refused case
 * must be impossible to use as a budget by accident: there is no `timeoutMs` on that arm to read.
 */
export type ShellTimeoutBudget =
  | {
      kind: 'granted';
      /** The wall-clock budget to arm, in ms. */
      timeoutMs: number;
      /** The ceiling in force for this call, in ms. */
      ceilingMs: number;
      /** Whether the CALL named this budget, as opposed to inheriting the configured default. */
      requested: boolean;
    }
  | {
      kind: 'refused';
      /** What the call asked for, in ms. */
      requestedMs: number;
      /** The ceiling it exceeded, in ms. */
      ceilingMs: number;
      /** The model-facing refusal to return INSTEAD of running anything. */
      message: string;
    };

/**
 * [[EXT-125]] — resolve a call's time budget against the config ceiling.
 *
 * **Over the ceiling is REFUSED, not clamped, and that is the whole safety story.** Silently
 * clamping would run the command on a budget the model did not ask for, kill it, and leave the
 * model reading a kill it has no way to attribute — a fact about our gate laundered into a claim
 * about the command, which is exactly what [[EXT-66]] settled must not happen. Refusing before the
 * spawn costs nothing (no process, no side effect, no output) and leaves the model one legible
 * move: re-call at or under a number it has now been told.
 *
 * `requestedMs` is validated here as well as in the schema. The schema is the only thing standing
 * between a provider's arguments and this function, and a tool argument is model-authored data on
 * the most safety-sensitive path in the repo; a second check costs one comparison and means the
 * ceiling does not depend on a zod version's coercion behaviour.
 */
export function resolveShellTimeoutBudget(
  requestedMs: number | undefined,
  defaultMs: number,
  ceilingMs: number
): ShellTimeoutBudget {
  if (requestedMs === undefined || !Number.isFinite(requestedMs) || requestedMs <= 0) {
    // Absent or unusable → exactly the pre-EXT-125 path: the configured/default budget, untouched.
    return { kind: 'granted', timeoutMs: defaultMs, ceilingMs, requested: false };
  }
  if (requestedMs > ceilingMs) {
    return {
      kind: 'refused',
      requestedMs,
      ceilingMs,
      message:
        `Refused before running anything: this call asked for a ${requestedMs}ms time budget, ` +
        `and the ceiling for this tool is ${ceilingMs}ms. No command was executed. ` +
        `Re-call with timeoutMs at or below ${ceilingMs}, split the work into steps that each fit, ` +
        `or ask the user to raise builtInTools.run_shell_command.maxTimeout in config.`,
    };
  }
  return { kind: 'granted', timeoutMs: requestedMs, ceilingMs, requested: true };
}

/**
 * [[EXT-125]] — the tail appended to a KILLED command's model-facing body.
 *
 * **It must not read like a non-zero exit, because it is not one.** A timeout is a fact about this
 * tool's gate: the command did not fail, did not finish, and reported nothing. A model that cannot
 * tell the two apart has only one repair move — re-run the identical command — which is what makes
 * a long build unappealable. So this text says three things the exit-code text never says: that the
 * kill came from a BUDGET, what that budget was in ms, and what to do differently next time.
 *
 * The move offered depends on whether there is headroom left: under the ceiling the model can ask
 * for more itself, and at the ceiling it cannot, so offering `timeoutMs` there would promise a move
 * that does not exist and cost a wasted turn discovering it.
 */
export function buildTimeoutKillNotice(
  command: string,
  timeoutMs: number,
  ceilingMs: number
): string {
  const move =
    timeoutMs < ceilingMs
      ? `To give it longer, re-call with timeoutMs up to ${ceilingMs} (this call used ${timeoutMs}).`
      : `This call already used the ${ceilingMs}ms ceiling, so a longer run needs ` +
        `builtInTools.run_shell_command.maxTimeout raised in config — asking for more is refused.`;
  return (
    `Command '${command}' hit its ${timeoutMs}ms time budget and was killed by this tool. ` +
    `It did not fail and it did not finish: nothing above is a result the command reported, and ` +
    `no exit code exists. Any output above is what it wrote before the kill. ${move}`
  );
}

// Helper function to create a tool with dev type. The fn's second parameter is LangChain's
// ToolRunnableConfig — when the framework invokes the tool with a ToolCall, `config.toolCall.id`
// identifies the call, which TUI-C17 threads into the live-output channel for attribution.
function createGthTool<T extends z.ZodSchema>(
  fn: (args: z.infer<T>, config?: ToolRunnableConfig) => Promise<string>,
  config: {
    name: string;
    description: string;
    schema: T;
  },
  gthDevType: 'execute'
): StructuredToolInterface {
  const toolInstance = tool(fn, config);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (toolInstance as any).gthDevType = gthDevType;
  return toolInstance;
}

/**
 * [[EXT-125]] — the per-call time budget argument, shared by EVERY tool in this toolkit.
 *
 * `.int().min(1)` and NOT `.positive()`: zod-4 serialises `.positive()` as JSON-Schema
 * `exclusiveMinimum`, which Google Gemini's function-declaration subset rejects outright — see the
 * GS2-56 guard in `packages/agent/spec/builtInToolsGeminiSchema.spec.ts`.
 *
 * The description names the EFFECTIVE ceiling rather than a constant, which is why the schema is
 * built per toolkit instance instead of living at module scope: a model told the real number asks
 * for a legal one first time, where a model told a generic rule spends a turn discovering the
 * project's. Milliseconds are in the argument's NAME because the repo has both conventions —
 * `builtInTools.run_shell_command.timeout` is ms while a custom tool's `timeout` is seconds — and a
 * model guessing wrong by a factor of a thousand is a silently absurd budget in either direction.
 */
const timeoutMsArg = (ceilingMs: number) =>
  z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'Optional. Wall-clock budget for THIS call, in milliseconds, after which the command (and ' +
        'its process group) is killed. Omit it to use the project default. Supply it when you ' +
        'have reason to expect this particular command to run long — a full test suite, a clean ' +
        `build, a large clone. The maximum accepted here is ${ceilingMs}; a larger value is ` +
        'refused without running anything.'
    );

/**
 * Schema definitions for built-in tools.
 *
 * **[[EXT-199]] deliberate decision: the fixed `run_*` tools do NOT take `cwd`.**
 * Three reasons:
 *  1. **Configured at project root:** Fixed tools (`run_tests`, `run_build`, `run_lint`) run
 *     commands statically authored in `.gsloth.config.*` specifically meant for the project root.
 *  2. **Zero-friction vs unprompted escape:** Fixed commands execute without an approval gate.
 *     Accepting `cwd` on fixed tools would allow directory traversal outside the project on an
 *     unprompted path, or require introducing approval prompts to historically unprompted tools.
 *  3. **`run_shell_command` already covers subdirectory execution:** If the agent needs to run
 *     tests or linting in a specific workspace directory, `run_shell_command` with `cwd` provides
 *     the exact mechanism with full approval gating and safety verification.
 *
 * **[[EXT-125]] scope item 3, decided: the fixed `run_*` tools take the per-call budget too.**
 * Three reasons, in the order that decided it:
 *
 *  1. **The node's own worked example is a fixed tool.** `run_tests` is the likeliest command in
 *     any repo to want ten minutes. Shipping the appeal on `run_shell_command` alone would close
 *     the gap everywhere except the place it was most likely to be felt, and leave a model whose
 *     test suite was killed with the one move the node exists to remove: re-run it unchanged.
 *  2. **"The user configures the command, so the user owns its timeout" does not distinguish
 *     them.** `getShellTimeoutMs` reads ONE value — the `run_shell_command` registry entry's
 *     `timeout` — and it governs all five tools. Whatever authority that argument gives the user
 *     over `run_tests`, it gives identically over `run_shell_command`.
 *  3. **A budget grants strictly less on a fixed tool.** The model cannot choose what runs there;
 *     the command is the user's own string. The argument moves one bounded number, and
 *     {@link getShellMaxTimeoutMs} bounds it the same way on every tool, through the same seam in
 *     {@link GthDevToolkit.executeCommand} — there is no second code path to keep honest.
 *
 * **The rejected alternative, recorded so it is not silently re-adopted:** leave the three
 * no-argument schemas as `z.object({})` so the model supplies no input at all on the fixed-tool
 * path, on the ground that a path with zero model-authored input is a smaller attack surface than
 * one with a validated integer. Rejected because the surface it protects is not the dangerous one —
 * the command string is what makes `run_shell_command` sensitive, and that is user-authored here —
 * while the cost is leaving the node's motivating case unfixed. If that trade is ever re-argued,
 * re-argue it against reason 2, which is the load-bearing one.
 *
 * `run_single_test` gains `timeoutMs` and NOT a second string: `testPath` goes through
 * {@link GthDevToolkit.validateParameterValue} because it is interpolated into a shell command, and
 * a number that is only ever compared to a ceiling must never be routed through a string sanitizer.
 */
const RunTestsArgsSchema = (ceilingMs: number) => z.object({ timeoutMs: timeoutMsArg(ceilingMs) });
const RunLintArgsSchema = (ceilingMs: number) => z.object({ timeoutMs: timeoutMsArg(ceilingMs) });
const RunBuildArgsSchema = (ceilingMs: number) => z.object({ timeoutMs: timeoutMsArg(ceilingMs) });
const RunSingleTestArgsSchema = (ceilingMs: number) =>
  z.object({
    testPath: z.string().describe('Relative path to the test file to run'),
    timeoutMs: timeoutMsArg(ceilingMs),
  });
const RunShellCommandArgsSchema = (ceilingMs: number) =>
  z.object({
    command: z.string().describe('The shell command to run'),
    timeoutMs: timeoutMsArg(ceilingMs),
    /**
     * [[EXT-29]] (spec §5.1, §7) — **the move §7 already promises the model and it could not make.**
     * The rejection message names *"call the same command with a justification"* among the moves
     * available after a refusal; without an argument to carry one, the only way to act on that was
     * to re-send the identical call, which is what makes an agent repeat itself and burn §5.3's cap
     * without producing information.
     *
     * It reaches the rater as fenced, untrusted data, weighed asymmetrically (§5.1): a
     * justification may only ever make an outcome LESS severe, and a stated intent that does not
     * match what the command does is grounds for rejection rather than for a discount. Never sent
     * for its own sake — an unprompted one is noise the rater still has to read.
     */
    justification: z
      .string()
      .optional()
      .describe(
        'Optional. Why this command is the right one, in a sentence or two — supply it when ' +
          'RE-CALLING a command that was rejected, so the reviewer can weigh what you are trying ' +
          'to do. Address the objection you were given rather than restating the request; a ' +
          'justification that does not match what the command actually does is rejected outright.'
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        'Optional. Working directory to run the command in. Relative paths resolve against the ' +
          'session work directory. If omitted, runs in the session work directory.'
      ),
  });

const TEST_PATH_PLACEHOLDER = '${testPath}';

export default class GthDevToolkit extends BaseToolkit {
  tools: StructuredToolInterface[];
  private commands: GthDevToolsConfig;
  /**
   * The active command, threaded through so the EXT-12 absent-config default for the shell
   * tool (ON in `code`, OFF elsewhere) is resolved consistently with the approval-interrupt
   * wiring. Omitted → historical OFF-by-default behaviour.
   */
  private readonly command: GthCommand | undefined;

  constructor(commands: GthDevToolsConfig = {}, command?: GthCommand | undefined) {
    super();
    this.commands = commands;
    this.command = command;
    this.tools = this.createTools();
  }

  /**
   * Get tools filtered by operation type
   */
  getFilteredTools(allowedOperations: 'execute'[]): StructuredToolInterface[] {
    return this.tools.filter((tool) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolType = (tool as any).gthDevType;
      return allowedOperations.includes(toolType);
    });
  }

  /**
   * Validate parameter value to prevent security issues
   */
  validateParameterValue(paramValue: string, paramName: string): string {
    // Check for absolute paths
    if (path.isAbsolute(paramValue)) {
      throw new Error(`Absolute paths are not allowed for parameter '${paramName}'`);
    }

    // Check for directory traversal attempts
    if (paramValue.includes('..') || paramValue.includes('\\..\\') || paramValue.includes('/../')) {
      throw new Error(`Directory traversal attempts are not allowed in parameter '${paramName}'`);
    }

    // Check for pipe attempts and other shell injection
    if (
      paramValue.includes('|') ||
      paramValue.includes('&') ||
      paramValue.includes(';') ||
      paramValue.includes('`') ||
      paramValue.includes('$') ||
      paramValue.includes('$(') ||
      paramValue.includes('\n') ||
      paramValue.includes('\r')
    ) {
      throw new Error(`Shell injection attempts are not allowed in parameter '${paramName}'`);
    }

    // Check for null bytes
    if (paramValue.includes('\0')) {
      throw new Error(`Null bytes are not allowed in parameter '${paramName}'`);
    }

    // Normalize the path to remove any redundant separators
    const normalizedValue = path.normalize(paramValue);

    // Double-check after normalization
    if (normalizedValue.includes('..')) {
      throw new Error(`Directory traversal attempts are not allowed in parameter '${paramName}'`);
    }

    return normalizedValue;
  }

  /**
   * Build the command for running a single test file
   */
  private buildSingleTestCommand(testPath: string): string {
    if (this.commands.run_single_test) {
      if (this.commands.run_single_test.includes(TEST_PATH_PLACEHOLDER)) {
        // Interpolate if placeholder is available
        return this.commands.run_single_test.replace(TEST_PATH_PLACEHOLDER, testPath);
      } else {
        // Concatenate if no placeholder
        return `${this.commands.run_single_test} ${testPath}`;
      }
    } else {
      throw new Error('No test command configured');
    }
  }

  /**
   * Execute a shell command with the EXT-9 Tier-1 hardening applied:
   *  1. stdin closed + timeout + process-group kill (no hang on interactive
   *     commands; runaway commands are killed group-wide on timeout),
   *     [[EXT-125]]: `requestedTimeoutMs` lets ONE call ask for a longer wall-clock budget, bounded
   *     by {@link getShellMaxTimeoutMs}; over the ceiling the call is refused without spawning
   *     anything, and an ABSENT argument resolves to precisely {@link getShellTimeoutMs} — the
   *     value, the spawn and the clean/non-zero-exit bodies are all unchanged by this parameter's
   *     existence,
   *  2. output capped with a head/tail window + temp-file spillover,
   *  3. provider/LLM credentials scrubbed from the child env,
   *  4. an unbypassable hardline blocklist (refuses catastrophic commands BEFORE
   *     spawn — fires even when confirmation is bypassed by approvals.mode: bypass).
   *
   * Resolves with a model-facing string on a CLEAN exit (`code === 0`). EXT-20: a non-zero exit
   * and a timeout-kill instead REJECT with a {@link ShellCommandFailedError} that carries the FULL
   * model-facing body — the agent's `GthLeanShellExitSoftening` middleware converts that
   * throw into an error `ToolMessage` (status:'error' → ✗) while preserving the output, so the
   * model still sees the killed-after-N / exit-code message and can continue. GS2-36: spawn-level
   * failures (`child.on('error')` — missing shell binary, a non-existent cwd, EMFILE, …) ALSO reject
   * with a {@link ShellCommandFailedError} (exitCode null) so the same softener converts them into a
   * recoverable error `ToolMessage`; previously they rejected a plain `Error` the softener did not
   * recognise, so a spawn failure aborted the whole run.
   */
  private async executeCommand(
    command: string,
    toolName: string,
    toolCallId?: string,
    requestedTimeoutMs?: number,
    requestedCwd?: string
  ): Promise<string> {
    // TUI-C17: the "Executing" notice + live child output go through the tool-output channel.
    // With no subscriber (every non-TUI surface) the channel's default sink reproduces the
    // historical behaviour exactly (displayInfo notice, raw stdout chunks); under the Ink TUI
    // the session subscribes and folds them into the managed frame instead.
    emitToolOutput({
      toolCallId,
      toolName,
      kind: 'notice',
      text: `🔧 Executing ${toolName}: ${command}`,
    });

    // (4) Hardline blocklist — checked here so it fires regardless of the approval mode,
    // allow-lists, or any confirmation path. Refuse WITHOUT executing. The approvals gate consults
    // the SAME floor before it rates or prompts ([[EXT-29]] §4.2), so a matching command normally
    // never reaches this line; this call is the guarantee that holds when nothing gated it at all.
    const hardline = checkHardline(command);
    if (hardline) {
      const refusal = buildHardlineRefusal(command, hardline);
      // TUI-C31 (a): route through the tool-output channel so the refusal lands in the managed
      // frame under the TUI (headless still gets displayWarning via the default sink, verbatim).
      emitToolOutput({ toolCallId, toolName, kind: 'warning', text: `\n⛔ ${refusal}` });
      return refusal;
    }

    // [[EXT-125]] — the call's own budget, bounded by the config ceiling. Resolved HERE, beside the
    // hardline refusal and before the spawn, so an over-ceiling ask costs no process and no side
    // effect; and resolved from `this.commands` alone, so nothing the model sent can widen it.
    const ceilingMs = getShellMaxTimeoutMs(this.commands);
    const budget = resolveShellTimeoutBudget(
      requestedTimeoutMs,
      getShellTimeoutMs(this.commands),
      ceilingMs
    );
    if (budget.kind === 'refused') {
      // Returned, not thrown, and for the same reason the hardline refusal above is: nothing ran,
      // so there is no command outcome to report. A ShellCommandFailedError here would file a fact
      // about this tool's gate under a type whose name asserts the COMMAND failed.
      emitToolOutput({ toolCallId, toolName, kind: 'warning', text: `\n⏱ ${budget.message}` });
      return budget.message;
    }
    const timeoutMs = budget.timeoutMs;
    const maxOutputBytes = getShellMaxOutputBytes(this.commands);

    // [[EXT-199]] — validate and resolve cwd if provided.
    // Validated in the tool schema and again here in the resolver before spawn.
    let spawnCwd: string;
    if (requestedCwd !== undefined) {
      const resolved = resolveShellCwd(requestedCwd);
      if (resolved.kind === 'refused') {
        // Refusal: nonexistent or non-directory cwd runs nothing.
        emitToolOutput({ toolCallId, toolName, kind: 'warning', text: `\n📁 ${resolved.message}` });
        return resolved.message;
      }
      spawnCwd = resolved.cwd;
    } else {
      spawnCwd = getShellWorkDir();
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        // EXT-22 (S4) / EXT-23: spawn in the SAME directory the filesystem tools are rooted at, so
        // the shell tool and the fs tools operate on one path namespace instead of diverging.
        // Resolved through the shared seam (see tools/shell/workDir.ts) and evaluated at call time.
        // [[EXT-199]] honours per-call cwd, falling back to getShellWorkDir() when omitted.
        cwd: spawnCwd,
        // (1) Never let the child block on stdin (e.g. git commit opening $EDITOR).
        stdio: ['ignore', 'pipe', 'pipe'],
        // (1) POSIX: own process group so we can kill the whole tree on timeout
        // (see killProcessGroup). No-op/harmful on Windows, which uses taskkill /T.
        detached: process.platform !== 'win32',
        // (3) Child env with provider/LLM credentials removed.
        env: buildScrubbedEnv(),
      });

      // (2) Bounded capture for the returned message; live streaming is uncapped.
      const buffer = new OutputBuffer(maxOutputBytes);
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const timeoutTimer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child, 'SIGTERM');
        // Escalate to SIGKILL after a short grace if it didn't die.
        killTimer = setTimeout(() => killProcessGroup(child, 'SIGKILL'), KILL_GRACE_MS);
        // killTimer must not keep the event loop alive on its own.
        killTimer.unref?.();
      }, timeoutMs);
      timeoutTimer.unref?.();

      const clearTimers = (): void => {
        clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          const chunk = data.toString();
          emitToolOutput({ toolCallId, toolName, kind: 'output', text: chunk });
          buffer.append(chunk);
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const chunk = data.toString();
          emitToolOutput({ toolCallId, toolName, kind: 'output', text: chunk });
          buffer.append(chunk);
        });
      }

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimers();

        const captured = buffer.finalize();
        const body =
          `Executing '${command}'...\n\n` +
          `<COMMAND_OUTPUT>\n` +
          captured.text +
          `</COMMAND_OUTPUT>\n`;

        if (timedOut) {
          // EXT-20: a timeout-kill is a failure — reject so the softening middleware flips the
          // tool result to status:'error' (✗). The FULL body is preserved on the error so the
          // model's observation is unchanged except for the status.
          reject(
            new ShellCommandFailedError({
              // [[EXT-125]] — the tail names the budget in ms and the move that changes the next
              // attempt, and shares NO sentence with the exit-code tail below: a model that cannot
              // tell a kill from a failure can only re-run the same command.
              output: body + '\n\n' + buildTimeoutKillNotice(command, timeoutMs, ceilingMs),
              exitCode: null,
              command,
              toolName,
            })
          );
          return;
        }

        if (code === 0) {
          resolve(body + `\n\nCommand '${command}' completed successfully`);
        } else {
          // EXT-20: a non-zero exit is a failure — reject (was resolve) so the softening
          // middleware surfaces the ✗ (isError) signal while preserving the full output body.
          reject(
            new ShellCommandFailedError({
              output: body + `\n\nCommand '${command}' exited with code ${code}`,
              exitCode: code,
              command,
              toolName,
            })
          );
        }
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimers();
        // GS2-36: a spawn-level failure used to reject a plain Error, which the softener
        // (GthLeanShellExitSoftening) does not recognise — so it propagated to GthAgentRunner as a
        // fatal `Stream processing failed` and crashed the run. Reject a ShellCommandFailedError
        // (exitCode null, like a timeout-kill) so the softener converts it into a recoverable
        // status:'error' ToolMessage and the model can route around it.
        // The message is phrased as an action-oriented recovery hint (EXT-34 hermes style).
        const errorMsg =
          `Failed to start command '${command}': ${error.message}. ` +
          'Check that the command/executable exists and the working directory is valid, then retry.';
        // TUI-C31 (a): route through the tool-output channel so the spawn-error advisory lands in
        // the managed frame under the TUI (headless still gets displayError via the default sink).
        emitToolOutput({ toolCallId, toolName, kind: 'error', text: errorMsg });
        reject(
          new ShellCommandFailedError({
            output: errorMsg,
            exitCode: null,
            command,
            toolName,
          })
        );
      });
    });
  }

  private createTools(): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [];
    // [[EXT-125]] — the effective ceiling, read once so every tool's `timeoutMs` description names
    // the SAME number the seam will enforce. `executeCommand` re-reads it rather than closing over
    // this one. Today the two reads cannot disagree: `this.commands` is assigned in the constructor
    // and never reassigned, so this is belt-and-braces, not a guard against an observed divergence.
    // It is worth the second call anyway, because it keeps the enforced bound a function of config
    // at the moment of the spawn rather than of whatever a description was built from.
    const ceilingMs = getShellMaxTimeoutMs(this.commands);

    if (this.commands.run_tests) {
      tools.push(
        createGthTool(
          async (
            args: z.infer<ReturnType<typeof RunTestsArgsSchema>>,
            config?: ToolRunnableConfig
          ): Promise<string> => {
            return await this.executeCommand(
              this.commands.run_tests!,
              'run_tests',
              config?.toolCall?.id,
              args.timeoutMs
            );
          },
          {
            name: 'run_tests',
            description:
              'Execute the test suite for this project. Runs the configured test command and returns the output.' +
              `\nThe configured command is [${this.commands.run_tests!}].`,
            schema: RunTestsArgsSchema(ceilingMs),
          },
          'execute'
        )
      );
    }

    if (this.commands.run_single_test) {
      tools.push(
        createGthTool(
          async (
            args: z.infer<ReturnType<typeof RunSingleTestArgsSchema>>,
            config?: ToolRunnableConfig
          ): Promise<string> => {
            const validatedPath = this.validateParameterValue(args.testPath, 'testPath');
            const command = this.buildSingleTestCommand(validatedPath);
            return await this.executeCommand(
              command,
              'run_single_test',
              config?.toolCall?.id,
              args.timeoutMs
            );
          },
          {
            name: 'run_single_test',
            description:
              'Execute a single test file. Runs the configured test command with the specified test file path. ' +
              'The test path must be relative and cannot contain directory traversal attempts or shell injection. ' +
              `\nThe base command is [${this.commands.run_single_test}].`,
            schema: RunSingleTestArgsSchema(ceilingMs),
          },
          'execute'
        )
      );
    }

    if (this.commands.run_lint) {
      tools.push(
        createGthTool(
          async (
            args: z.infer<ReturnType<typeof RunLintArgsSchema>>,
            config?: ToolRunnableConfig
          ): Promise<string> => {
            return await this.executeCommand(
              this.commands.run_lint!,
              'run_lint',
              config?.toolCall?.id,
              args.timeoutMs
            );
          },
          {
            name: 'run_lint',
            description:
              'Run the linter on the project code. Executes the configured lint command and returns any linting errors or warnings.' +
              `\nThe configured command is [${this.commands.run_lint!}].`,
            schema: RunLintArgsSchema(ceilingMs),
          },
          'execute'
        )
      );
    }

    if (this.commands.run_build) {
      tools.push(
        createGthTool(
          async (
            args: z.infer<ReturnType<typeof RunBuildArgsSchema>>,
            config?: ToolRunnableConfig
          ): Promise<string> => {
            return await this.executeCommand(
              this.commands.run_build!,
              'run_build',
              config?.toolCall?.id,
              args.timeoutMs
            );
          },
          {
            name: 'run_build',
            description:
              'Build the project. Executes the configured build command and returns the build output.' +
              `\nThe configured command is [${this.commands.run_build!}].`,
            schema: RunBuildArgsSchema(ceilingMs),
          },
          'execute'
        )
      );
    }

    // Opt-in general-purpose shell tool. Unlike the fixed run_* commands, the model supplies
    // the command, so the guardrail is the per-command confirmation dialog wired by the agent
    // (`interruptOn`), not a parameter sanitizer — a real shell command
    // legitimately contains pipes / `$` / `;`, so validateParameterValue must NOT be applied.
    if (isShellToolEnabled(this.commands, this.command)) {
      tools.push(
        createGthTool(
          async (
            args: z.infer<ReturnType<typeof RunShellCommandArgsSchema>>,
            config?: ToolRunnableConfig
          ): Promise<string> => {
            return await this.executeCommand(
              args.command,
              'run_shell_command',
              config?.toolCall?.id,
              args.timeoutMs,
              args.cwd
            );
          },
          {
            name: 'run_shell_command',
            description:
              'Run an arbitrary shell command in the project working directory and return its ' +
              'combined stdout/stderr and exit status. Use for any task the fixed run_* tools do ' +
              'not cover (e.g. git, package managers, file inspection). Each call is subject to ' +
              'human approval before it runs unless approval has been disabled. A command that ' +
              'outlives its time budget is KILLED, which is not the same as failing — the result ' +
              'says so, and timeoutMs is how you ask for longer.',
            schema: RunShellCommandArgsSchema(ceilingMs),
          },
          'execute'
        )
      );
    }

    return tools;
  }
}
