import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandEnvPolicy } from '#src/tools/shell/env.js';

/**
 * EXT-42 / EXT-126 — real-spawn acceptance gate for the custom-tool child environment.
 *
 * Like GthCustomToolkitSpawnStdin.spec.ts (and unlike GthCustomToolkit.spec.ts, which mocks
 * child_process wholesale), this spawns a REAL child so it exercises the actual `env` spawn option
 * produced by buildCommandEnv(). Fixture secrets are planted in the PARENT env; the probe echoes its
 * OWN environment; each case asserts what the child actually received.
 *
 * EXT-126 made scrubbing opt-in, so the matrix is: scrubbing off (the default) inherits the
 * fixture, scrubbing on removes it, and a passthrough list keeps exactly the named variable while
 * removing the rest. Both fixture names end in a credential ending (`SECRET`, `TOKEN`), so absence
 * under scrubbing is a scrub rather than a name the sweep never considered.
 *
 * `executeCommand` is called directly (as in GthCustomToolkitSpawnStdin.spec.ts) to bypass the
 * parameter validator — the env is a spawn-time property independent of the build/validate path.
 */
describe('GthCustomToolkit executeCommand child env (EXT-42 / EXT-126, real spawn)', () => {
  let tmpDir: string;
  let probeScript: string;

  const SECRET_VALUE = 'fixture-secret-value-EXT126';
  const TOKEN_VALUE = 'fixture-token-value-EXT126';

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gth-ext126-env-'));
    probeScript = path.join(tmpDir, 'env-probe.cjs');
    // Echo both fixtures (empty when removed) and a sentinel proving a generic var (PATH) survived,
    // so a builder that nuked the whole env can't pass. An optional argv exit code lets a case
    // exercise the non-zero path.
    writeFileSync(
      probeScript,
      [
        "process.stdout.write('SECRET=[' + (process.env.EXT126_FIXTURE_SECRET || '') + ']');",
        "process.stdout.write('|TOKEN=[' + (process.env.EXT126_FIXTURE_TOKEN || '') + ']');",
        "process.stdout.write('|PATH_PRESENT=' + (process.env.PATH ? 'yes' : 'no'));",
        'process.exit(Number(process.argv[2] || 0));',
        '',
      ].join('\n')
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.EXT126_FIXTURE_SECRET;
    delete process.env.EXT126_FIXTURE_TOKEN;
  });

  const runProbe = async (policy: CommandEnvPolicy | undefined, exitCode = 0): Promise<string> => {
    const { subscribeToolOutput } = await import('@gaunt-sloth/core/core/toolOutputChannel.js');
    const { default: GthCustomToolkit } = await import('#src/tools/GthCustomToolkit.js');

    process.env.EXT126_FIXTURE_SECRET = SECRET_VALUE;
    process.env.EXT126_FIXTURE_TOKEN = TOKEN_VALUE;

    const toolkit =
      policy === undefined ? new GthCustomToolkit({}) : new GthCustomToolkit({}, policy);
    // Keep the live notice/output chunks off the real console during the test.
    const unsubscribe = subscribeToolOutput(() => {});
    try {
      // Quote the path so a temp dir with spaces (or backslashes on Windows) survives the shell.
      return await toolkit['executeCommand'](`node "${probeScript}" ${exitCode}`, 'env_probe', 20);
    } finally {
      unsubscribe();
    }
  };

  it('scrubbing off (default): the child inherits the fixture credentials', async () => {
    const result = await runProbe(undefined);
    expect(result).toContain(`SECRET=[${SECRET_VALUE}]`);
    expect(result).toContain(`TOKEN=[${TOKEN_VALUE}]`);
    expect(result).toContain('PATH_PRESENT=yes');
    expect(result).toContain('completed successfully');
  }, 30_000);

  it('scrubbing on: the fixture credentials are gone from the child (present in parent)', async () => {
    const result = await runProbe({ scrubCredentials: true, passthrough: [] });
    expect(process.env.EXT126_FIXTURE_SECRET).toBe(SECRET_VALUE);
    expect(result).toContain('SECRET=[]');
    expect(result).toContain('TOKEN=[]');
    expect(result).not.toContain(SECRET_VALUE);
    expect(result).not.toContain(TOKEN_VALUE);
    expect(result).toContain('PATH_PRESENT=yes');
    expect(result).toContain('completed successfully');
  }, 30_000);

  it('scrubbing on with passthrough: keeps exactly the named variable, removes the rest', async () => {
    const result = await runProbe({
      scrubCredentials: true,
      passthrough: ['ext126_fixture_token'],
    });
    expect(result).toContain('SECRET=[]');
    expect(result).toContain(`TOKEN=[${TOKEN_VALUE}]`);
    expect(result).toContain('PATH_PRESENT=yes');
  }, 30_000);

  it('scrubbing on: a non-zero exit names the removed variables, never their values', async () => {
    const result = await runProbe({ scrubCredentials: true, passthrough: [] }, 3);
    expect(result).toContain('exited with code 3');
    const line = result.split('\n').find((l) => l.includes('commandEnv.scrubCredentials'));
    expect(line).toBeDefined();
    expect(line).toContain('EXT126_FIXTURE_SECRET');
    expect(line).toContain('EXT126_FIXTURE_TOKEN');
    expect(result).not.toContain(SECRET_VALUE);
    expect(result).not.toContain(TOKEN_VALUE);
  }, 30_000);

  it('scrubbing off: a non-zero exit carries no scrub line', async () => {
    const result = await runProbe(undefined, 3);
    expect(result).toContain('exited with code 3');
    expect(result).not.toContain('commandEnv.scrubCredentials');
  }, 30_000);

  it('scrubbing on: a clean exit carries no scrub line', async () => {
    const result = await runProbe({ scrubCredentials: true, passthrough: [] });
    expect(result).toContain('completed successfully');
    expect(result).not.toContain('commandEnv.scrubCredentials');
  }, 30_000);
});
