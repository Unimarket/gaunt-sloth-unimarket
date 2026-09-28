import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const consoleUtilsMock = {
  display: vi.fn(),
  displayError: vi.fn(),
  displayInfo: vi.fn(),
  displayWarning: vi.fn(),
  displaySuccess: vi.fn(),
  displayDebug: vi.fn(),
  setConsoleLevel: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', () => consoleUtilsMock);

let mockCwd = '';
let mockProjectDir: string | undefined = undefined;
vi.mock('#src/utils/systemUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/systemUtils.js')>();
  return {
    ...actual,
    getCurrentWorkDir: () => mockCwd,
    getProjectDir: () => mockProjectDir ?? mockCwd,
    setProjectDir: (dir: string | undefined) => {
      mockProjectDir = dir;
    },
    isTTY: () => true,
    isStdoutTTY: () => true,
  };
});

// Only the home dir is faked, so the global config lookup runs for real — against a temp directory,
// never this machine's own `~/.gsloth`.
const homeDirMock = { dir: '' };
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeDirMock.dir };
});

/**
 * EXT-126 — the passthrough warning is checked on the MERGED config, not per layer, because a
 * global layer that turns scrubbing on plus a project layer that names passthrough variables is a
 * valid pair. These cells load both layers through the real `initConfig` layering (global config
 * underlaid, project config merged on top), so moving the check into a single layer's validation
 * would warn on the valid pair and red the first two cells.
 */
describe('EXT-126 — commandEnv passthrough warning across config layers', () => {
  let projectRoot: string;
  let homeRoot: string;
  let globalRoot: string;

  beforeEach(() => {
    vi.resetAllMocks();
    mockProjectDir = undefined;
    projectRoot = mkdtempSync(resolve(tmpdir(), 'gsloth-ext126-project-'));
    homeRoot = mkdtempSync(resolve(tmpdir(), 'gsloth-ext126-home-'));
    mockCwd = projectRoot;
    homeDirMock.dir = homeRoot;
    globalRoot = resolve(homeRoot, '.gsloth');
    mkdirSync(globalRoot, { recursive: true });
    mkdirSync(resolve(projectRoot, '.git'), { recursive: true });

    vi.doMock('#src/providers/vertexai.js', () => ({
      processJsonConfig: vi.fn().mockImplementation((llm: Record<string, unknown>) => ({
        type: 'vertexai',
        ...llm,
      })),
      postProcessJsonConfig: undefined,
    }));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeRoot, { recursive: true, force: true });
  });

  const writeConfig = (dir: string, content: Record<string, unknown>) =>
    writeFileSync(resolve(dir, '.gsloth.config.json'), JSON.stringify(content));

  const passthroughWarnings = () =>
    consoleUtilsMock.displayWarning.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('commandEnv.passthrough'));

  it('global turns scrubbing on, project names passthrough: merged, and no warning', async () => {
    writeConfig(globalRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { scrubCredentials: true },
    });
    writeConfig(projectRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { passthrough: ['GH_TOKEN'] },
    });

    const { initConfig } = await import('#src/config/loader.js');
    const resolved = await initConfig({});

    expect(resolved.commandEnv).toEqual({ scrubCredentials: true, passthrough: ['GH_TOKEN'] });
    expect(passthroughWarnings()).toHaveLength(0);
  });

  it('global names passthrough, project turns scrubbing on: merged, and no warning', async () => {
    writeConfig(globalRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { passthrough: ['GH_TOKEN'] },
    });
    writeConfig(projectRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { scrubCredentials: true },
    });

    const { initConfig } = await import('#src/config/loader.js');
    const resolved = await initConfig({});

    expect(resolved.commandEnv).toEqual({ scrubCredentials: true, passthrough: ['GH_TOKEN'] });
    expect(passthroughWarnings()).toHaveLength(0);
  });

  it('CONTROL: passthrough with scrubbing off in the merged config warns once', async () => {
    writeConfig(globalRoot, { llm: { type: 'vertexai' } });
    writeConfig(projectRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { passthrough: ['GH_TOKEN'] },
    });

    const { initConfig } = await import('#src/config/loader.js');
    await initConfig({});

    expect(passthroughWarnings()).toHaveLength(1);
  });

  it('a project passthrough list replaces a global one rather than adding to it', async () => {
    writeConfig(globalRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { scrubCredentials: true, passthrough: ['GOOGLE_API_KEY'] },
    });
    writeConfig(projectRoot, {
      llm: { type: 'vertexai' },
      commandEnv: { passthrough: ['GH_TOKEN'] },
    });

    const { initConfig } = await import('#src/config/loader.js');
    const resolved = await initConfig({});

    expect(resolved.commandEnv?.passthrough).toEqual(['GH_TOKEN']);
  });
});
