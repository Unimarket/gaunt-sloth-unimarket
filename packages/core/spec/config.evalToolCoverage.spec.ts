import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// BATCH-48 — `loadConfiguredEvalToolCoverage`, the run-start reader `gth eval` takes its run floor
// from, asserted THROUGH THE REAL LOADER: real files in temp dirs, the real up-tree discovery, the
// real global lookup and layering. The same harness as config.tui.spec, mocking only three seams:
// - globalConfigUtils.getGlobalGslothConfigReadPath → a per-test temp "global" dir, so a test
//   never reads the developer's real ~/.gsloth config;
// - the vertexai provider module → initConfig would otherwise build a real LLM;
// - systemUtils.exit → throws instead of killing the vitest worker if an error path is hit.
//
// Every value the reader returns is also compared with what `initConfig` resolves for the same
// overrides: the reader exists so the eval command need not build a config to learn the floor, and
// it is only correct while it reaches the value a run reaches.
const { getGlobalGslothConfigReadPathMock, exitMock, processJsonConfigMock } = vi.hoisted(() => ({
  getGlobalGslothConfigReadPathMock:
    vi.fn<(_filename: string, _identityProfile?: string) => string>(),
  exitMock: vi.fn<(_code?: number) => never>(),
  processJsonConfigMock: vi.fn(),
}));
vi.mock('#src/utils/globalConfigUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/globalConfigUtils.js')>();
  return { ...actual, getGlobalGslothConfigReadPath: getGlobalGslothConfigReadPathMock };
});
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return { ...actual, exit: exitMock };
});
vi.mock('#src/providers/vertexai.js', () => ({
  processJsonConfig: processJsonConfigMock,
  postProcessJsonConfig: undefined,
}));

const FAKE_LLM = { fakeLlm: true };
const LLM_SPEC = { type: 'vertexai' };

describe('loadConfiguredEvalToolCoverage (BATCH-48)', () => {
  let root: string;
  let globalDir: string;
  let projectDir: string;
  const origInitCwd = process.env.INIT_CWD;

  beforeEach(async () => {
    vi.resetAllMocks();
    const { setProjectDir } = await import('#src/utils/systemUtils.js');
    setProjectDir(undefined);

    root = mkdtempSync(resolve(tmpdir(), 'gsloth-evalcov-'));
    globalDir = resolve(root, '__global__');
    mkdirSync(globalDir, { recursive: true });
    // `.git` stops the up-tree walk here, so discovery can never escape into the real repo.
    projectDir = resolve(root, 'proj');
    mkdirSync(resolve(projectDir, '.git'), { recursive: true });
    process.env.INIT_CWD = projectDir;

    const { resolveGlobalConfigPath } = await import('#src/utils/globalConfigUtils.js');
    getGlobalGslothConfigReadPathMock.mockImplementation((filename, identityProfile) =>
      resolveGlobalConfigPath(globalDir, filename, identityProfile)
    );
    exitMock.mockImplementation((code?: number) => {
      throw new Error(`exit(${code}) called`);
    });
    processJsonConfigMock.mockResolvedValue(FAKE_LLM);
  });

  afterEach(() => {
    if (origInitCwd === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = origInitCwd;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const writeProjectConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(projectDir, '.gsloth.config.json'), JSON.stringify(config));
  };
  const writeGlobalConfig = (config: Record<string, unknown>): void => {
    writeFileSync(resolve(globalDir, '.gsloth.config.json'), JSON.stringify(config));
  };
  const writeProfileConfig = (name: string, config: Record<string, unknown>): void => {
    const dir = resolve(projectDir, '.gsloth', '.gsloth-settings', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, '.gsloth.config.json'), JSON.stringify(config));
  };

  /** The reader's value next to the value a full `initConfig` reaches for the same overrides. */
  async function readBoth(overrides: { identityProfile?: string }) {
    const { loadConfiguredEvalToolCoverage, initConfig } = await import('#src/config/loader.js');
    const read = await loadConfiguredEvalToolCoverage(overrides);
    const { setProjectDir } = await import('#src/utils/systemUtils.js');
    setProjectDir(undefined);
    const built = await initConfig(overrides);
    return { read, runValue: built.evalToolCoverage };
  }

  describe('the profile-or-project pair — cells that differ only in which config carries the floor', () => {
    it('reads the floor from the -i profile when one is given', async () => {
      // The profile carries the floor; the plain project config does not.
      writeProjectConfig({ llm: LLM_SPEC });
      writeProfileConfig('mcp-eval-root', {
        llm: LLM_SPEC,
        evalToolCoverage: { min: 13, waive: ['read_file'] },
      });

      const { read, runValue } = await readBoth({ identityProfile: 'mcp-eval-root' });
      expect(read).toEqual({
        found: true,
        layer: 'project',
        value: { min: 13, waive: ['read_file'] },
      });
      expect(read.value).toEqual(runValue);

      // The same tree without `-i` has no floor: the profile is not read unless named.
      const plain = await readBoth({});
      expect(plain.read).toEqual({ found: true, layer: 'project' });
      expect(plain.runValue).toBeUndefined();
    });

    it('reads the floor from the project config when no -i is given', async () => {
      // The mirror image: the plain project config carries the floor; the profile does not.
      writeProjectConfig({ llm: LLM_SPEC, evalToolCoverage: { min: 13, waive: ['read_file'] } });
      writeProfileConfig('mcp-eval-root', { llm: LLM_SPEC });

      const { read, runValue } = await readBoth({});
      expect(read).toEqual({
        found: true,
        layer: 'project',
        value: { min: 13, waive: ['read_file'] },
      });
      expect(read.value).toEqual(runValue);

      // With `-i` the profile file IS the project layer, so the plain config's floor is not read.
      const profiled = await readBoth({ identityProfile: 'mcp-eval-root' });
      expect(profiled.read.value).toBeUndefined();
      expect(profiled.runValue).toBeUndefined();
    });
  });

  it('underlays the global config the way a run does, field by field', async () => {
    writeGlobalConfig({ llm: LLM_SPEC, evalToolCoverage: { min: 5, waive: ['write_file'] } });
    writeProjectConfig({ llm: LLM_SPEC, evalToolCoverage: { min: 20 } });

    const { read, runValue } = await readBoth({});
    expect(read.value).toEqual({ min: 20, waive: ['write_file'] });
    expect(read.value).toEqual(runValue);
  });

  it('follows a profile extends chain to a base that carries the floor', async () => {
    writeProfileConfig('base', { llm: LLM_SPEC, evalToolCoverage: { min: 40 } });
    writeProfileConfig('child', { extends: 'base' });

    const { read, runValue } = await readBoth({ identityProfile: 'child' });
    expect(read.value).toEqual({ min: 40 });
    expect(read.value).toEqual(runValue);
  });

  it('reads a global-only config as the global layer', async () => {
    writeGlobalConfig({ llm: LLM_SPEC, evalToolCoverage: { min: 7 } });

    const { read, runValue } = await readBoth({});
    expect(read).toEqual({ found: true, layer: 'global', value: { min: 7 } });
    expect(read.value).toEqual(runValue);
  });

  it('reports no base config when there is none anywhere, rather than a silent absent floor', async () => {
    const { loadConfiguredEvalToolCoverage } = await import('#src/config/loader.js');
    expect(await loadConfiguredEvalToolCoverage({})).toEqual({ found: false });
  });

  it('refuses a named profile with no config of its own, as a run does', async () => {
    // Discovery alone would fall back to this plain config, and the output would then name a
    // profile the floor never came from.
    writeProjectConfig({ llm: LLM_SPEC, evalToolCoverage: { min: 90 } });

    const { loadConfiguredEvalToolCoverage } = await import('#src/config/loader.js');
    await expect(loadConfiguredEvalToolCoverage({ identityProfile: 'typo' })).rejects.toThrow(
      'identity profile "typo" not found'
    );
  });

  it('throws on a malformed floor, naming the key, rather than treating it as no floor', async () => {
    writeProjectConfig({ llm: LLM_SPEC, evalToolCoverage: { min: 150 } });

    const { loadConfiguredEvalToolCoverage } = await import('#src/config/loader.js');
    await expect(loadConfiguredEvalToolCoverage({})).rejects.toThrow(
      'evalToolCoverage.min is a percentage between 0 and 100'
    );
  });

  // BATCH-51 — `reporters` is read by the same run-start pass, so a matrix suite (which builds no
  // base config) gets the reporters of the config the run was started with.
  describe('loadRunLevelEvalConfig reads reporters from the run-level config (BATCH-51)', () => {
    it('reads reporters from the -i profile, and only when that profile is named', async () => {
      writeProjectConfig({ llm: LLM_SPEC });
      writeProfileConfig('mcp-eval-root', {
        llm: LLM_SPEC,
        evalToolCoverage: { min: 13 },
        reporters: { teamcity: '@gaunt-sloth/eval-reporter-teamcity' },
      });

      const { loadRunLevelEvalConfig, initConfig } = await import('#src/config/loader.js');
      const read = await loadRunLevelEvalConfig({ identityProfile: 'mcp-eval-root' });
      expect(read).toEqual({
        found: true,
        layer: 'project',
        evalToolCoverage: { min: 13 },
        reporters: { teamcity: '@gaunt-sloth/eval-reporter-teamcity' },
      });
      const { setProjectDir } = await import('#src/utils/systemUtils.js');
      setProjectDir(undefined);
      const built = await initConfig({ identityProfile: 'mcp-eval-root' });
      expect(read.reporters).toEqual(built.reporters);

      setProjectDir(undefined);
      expect(await loadRunLevelEvalConfig({})).toEqual({ found: true, layer: 'project' });
    });

    it('underlays the global config reporters the way a run does', async () => {
      writeGlobalConfig({ llm: LLM_SPEC, reporters: { a: './global-a.mjs', b: './global-b.mjs' } });
      writeProjectConfig({ llm: LLM_SPEC, reporters: { b: './project-b.mjs' } });

      const { loadRunLevelEvalConfig } = await import('#src/config/loader.js');
      const read = await loadRunLevelEvalConfig({});
      expect(read.reporters).toEqual({ a: './global-a.mjs', b: './project-b.mjs' });
    });

    it('throws on malformed reporters, naming the key, rather than treating them as none', async () => {
      writeProjectConfig({ llm: LLM_SPEC, reporters: { teamcity: 42 } });

      const { loadRunLevelEvalConfig } = await import('#src/config/loader.js');
      await expect(loadRunLevelEvalConfig({})).rejects.toThrow('Invalid reporters');
    });
  });
});
