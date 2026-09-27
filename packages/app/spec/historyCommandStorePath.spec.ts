/**
 * GS2-119 — the read-only history commands open the store a run records into: `--db`, then
 * `history.dbPath` from the config (the project layer over the global one), then the default.
 * Before GS2-121 absorbed it, `gth history list` ignored the config and always read the default, so
 * a user with a configured store was told they had no history.
 *
 * Each case runs in a child process with a temp `HOME` and a temp project directory holding its own
 * `.git`, which stops the config walk there. Nothing here can see the developer's `~/.gsloth/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./fixtures/historyStorePathChild.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

describe('GS2-119 — which store the history commands open', () => {
  let dir: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gsloth-gs2119-'));
    home = join(dir, 'home');
    project = join(dir, 'project');
    mkdirSync(join(home, '.gsloth'), { recursive: true });
    mkdirSync(join(project, '.git'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete out.GTH_CONFIG;
    // `pnpm test` sets INIT_CWD to the repo root, and the working directory the config walk starts
    // from prefers it over the process cwd, so a child inheriting it would never see the project.
    delete out.INIT_CWD;
    return out;
  };

  const resolveIn = (db: string | undefined): { store: string; exists: boolean } =>
    JSON.parse(
      execFileSync(process.execPath, [CHILD, db ?? '-'], {
        cwd: project,
        env: env(),
        encoding: 'utf8',
      })
    ) as { store: string; exists: boolean };

  const globalConfig = (dbPath: string) =>
    writeFileSync(
      join(home, '.gsloth', '.gsloth.config.json'),
      JSON.stringify({ history: { dbPath } })
    );
  const projectConfig = (dbPath: string) =>
    writeFileSync(join(project, '.gsloth.config.json'), JSON.stringify({ history: { dbPath } }));

  it('with no config and no --db, the default under HOME — and resolving it creates nothing', () => {
    const resolved = resolveIn(undefined);
    expect(resolved.store).toBe(join(home, '.gsloth', 'history.db'));
    expect(resolved.exists).toBe(false);
  });

  it('the global config’s history.dbPath is used when no project config sets one', () => {
    globalConfig(join(dir, 'global-store'));
    expect(resolveIn(undefined).store).toBe(join(dir, 'global-store'));
  });

  it('the project config’s history.dbPath wins over the global one', () => {
    globalConfig(join(dir, 'global-store'));
    projectConfig(join(dir, 'project-store'));
    expect(resolveIn(undefined).store).toBe(join(dir, 'project-store'));
  });

  it('--db wins over both', () => {
    globalConfig(join(dir, 'global-store'));
    projectConfig(join(dir, 'project-store'));
    expect(resolveIn(join(dir, 'flag-store')).store).toBe(join(dir, 'flag-store'));
  });

  it('end to end: `gth history list` reads the configured store a run wrote, and does not create the default', () => {
    const configured = join(dir, 'configured-store');
    projectConfig(configured);
    // A store written where the config points, through a child with the same HOME.
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { openHistoryStore } = await import(${JSON.stringify(
          new URL('../../core/dist/history/historyStore.js', import.meta.url).href
        )});
           const s = openHistoryStore(${JSON.stringify(configured)}, { create: true });
           s.record({ command: 'ask', prompt: 'configured needle', response: 'r' });
           s.close();`,
      ],
      { cwd: project, env: env() }
    );

    const out = execFileSync(process.execPath, [CLI, 'history', 'list'], {
      cwd: project,
      env: env(),
      encoding: 'utf8',
    });
    expect(out).toContain('configured needle');
    expect(existsSync(join(home, '.gsloth', 'history.db'))).toBe(false);
  }, 60_000);
});
