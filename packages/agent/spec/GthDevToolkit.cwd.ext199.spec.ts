/**
 * EXT-199 — GthDevToolkit and GthCustomToolkit tests for per-call cwd argument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const childProcessMock = { spawn: vi.fn() };
vi.mock('child_process', () => childProcessMock);

vi.mock('#src/utils/consoleUtils.js', () => ({
  displayInfo: vi.fn(),
  displayError: vi.fn(),
  displayWarning: vi.fn(),
}));

let currentWorkDirMock = '/mock/project';
vi.mock('#src/utils/systemUtils.js', () => ({
  stdout: { write: vi.fn() },
  env: { PATH: '/usr/bin', HOME: '/home/test' },
  getCurrentWorkDir: vi.fn(() => currentWorkDirMock),
  getStartupWorkDir: vi.fn(() => currentWorkDirMock),
  setStartupWorkDir: vi.fn(),
}));

function makeChild() {
  const handlers: Record<string, (_arg: unknown) => void> = {};
  const stdoutHandlers: Record<string, (_arg: unknown) => void> = {};
  const stderrHandlers: Record<string, (_arg: unknown) => void> = {};
  return {
    child: {
      on: vi.fn((event: string, cb: (_arg: unknown) => void) => {
        handlers[event] = cb;
        if (event === 'close') {
          // Auto-close on next tick
          queueMicrotask(() => cb(0));
        }
      }),
      stdout: {
        on: vi.fn((event: string, cb: (_arg: unknown) => void) => {
          stdoutHandlers[event] = cb;
        }),
      },
      stderr: {
        on: vi.fn((event: string, cb: (_arg: unknown) => void) => {
          stderrHandlers[event] = cb;
        }),
      },
      kill: vi.fn(),
    },
    emitStdout: (text: string) => stdoutHandlers.data?.(Buffer.from(text)),
    emitStderr: (text: string) => stderrHandlers.data?.(Buffer.from(text)),
    close: (code: number | null) => handlers.close?.(code),
  };
}

describe('EXT-199 — GthDevToolkit cwd argument handling', () => {
  let tempBase: string;
  let projectDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tempBase = realpathSync(mkdtempSync(path.join(tmpdir(), 'ext199-devtoolkit-')));
    projectDir = path.join(tempBase, 'project');
    mkdirSync(projectDir, { recursive: true });
    currentWorkDirMock = projectDir;
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('declares optional cwd in run_shell_command schema, while fixed run_* schemas omit it', async () => {
    const GthDevToolkit = (await import('#src/tools/GthDevToolkit.js')).default;
    const toolkit = new GthDevToolkit({
      shell: { enabled: true },
      run_tests: 'npm test',
      run_build: 'npm run build',
      run_lint: 'npm run lint',
      run_single_test: 'vitest run ${testPath}',
    });

    const tools = toolkit.tools;
    const shellTool = tools.find((t) => t.name === 'run_shell_command');
    expect(shellTool).toBeDefined();

    // The schema includes cwd
    const shellSchema = (shellTool as any).schema;
    expect(shellSchema.shape.cwd).toBeDefined();

    // Fixed run_* tools deliberately omit cwd
    const testsTool = tools.find((t) => t.name === 'run_tests');
    expect((testsTool as any).schema.shape.cwd).toBeUndefined();

    const buildTool = tools.find((t) => t.name === 'run_build');
    expect((buildTool as any).schema.shape.cwd).toBeUndefined();

    const lintTool = tools.find((t) => t.name === 'run_lint');
    expect((lintTool as any).schema.shape.cwd).toBeUndefined();

    const singleTestTool = tools.find((t) => t.name === 'run_single_test');
    expect((singleTestTool as any).schema.shape.cwd).toBeUndefined();
  });

  it('spawns command with resolved cwd when relative cwd is supplied', async () => {
    const subDir = path.join(projectDir, 'packages', 'app');
    mkdirSync(subDir, { recursive: true });

    const c = makeChild();
    childProcessMock.spawn.mockReturnValue(c.child);

    const GthDevToolkit = (await import('#src/tools/GthDevToolkit.js')).default;
    const toolkit = new GthDevToolkit({ shell: { enabled: true } });
    const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;

    await shellTool.invoke({ command: 'pwd', cwd: 'packages/app' });

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'pwd',
      expect.objectContaining({
        cwd: realpathSync(subDir),
      })
    );
  });

  it('spawns command with getShellWorkDir() when cwd is omitted', async () => {
    const c = makeChild();
    childProcessMock.spawn.mockReturnValue(c.child);

    const GthDevToolkit = (await import('#src/tools/GthDevToolkit.js')).default;
    const toolkit = new GthDevToolkit({ shell: { enabled: true } });
    const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;

    await shellTool.invoke({ command: 'echo hi' });

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'echo hi',
      expect.objectContaining({
        cwd: realpathSync(projectDir),
      })
    );
  });

  it('refuses nonexistent cwd and does not spawn anything', async () => {
    const GthDevToolkit = (await import('#src/tools/GthDevToolkit.js')).default;
    const toolkit = new GthDevToolkit({ shell: { enabled: true } });
    const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;

    const result = await shellTool.invoke({ command: 'ls', cwd: 'nonexistent/path' });

    expect(result).toContain('Working directory does not exist');
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });

  it('refuses non-directory cwd and does not spawn anything', async () => {
    const filePath = path.join(projectDir, 'file.txt');
    writeFileSync(filePath, 'some text');

    const GthDevToolkit = (await import('#src/tools/GthDevToolkit.js')).default;
    const toolkit = new GthDevToolkit({ shell: { enabled: true } });
    const shellTool = toolkit.tools.find((t) => t.name === 'run_shell_command')!;

    const result = await shellTool.invoke({ command: 'ls', cwd: 'file.txt' });

    expect(result).toContain('Working directory is not a directory');
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });
});

describe('EXT-199 — GthCustomToolkit cwd handling', () => {
  let tempBase: string;
  let projectDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tempBase = realpathSync(mkdtempSync(path.join(tmpdir(), 'ext199-customtoolkit-')));
    projectDir = path.join(tempBase, 'project');
    mkdirSync(projectDir, { recursive: true });
    currentWorkDirMock = projectDir;
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('spawns custom tool in configured cwd when provided to executeCommand', async () => {
    const subDir = path.join(projectDir, 'sub');
    mkdirSync(subDir, { recursive: true });

    const c = makeChild();
    childProcessMock.spawn.mockReturnValue(c.child);

    const GthCustomToolkit = (await import('#src/tools/GthCustomToolkit.js')).default;
    const toolkit = new GthCustomToolkit({});

    await toolkit['executeCommand']('echo custom', 'custom_cmd', undefined, undefined, 'sub');

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'echo custom',
      expect.objectContaining({
        cwd: realpathSync(subDir),
      })
    );
  });
});
