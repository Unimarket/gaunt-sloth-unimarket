import { beforeEach, describe, expect, it, vi } from 'vitest';

const consoleUtilsMock = {
  displayWarning: vi.fn(),
};
vi.mock('#src/utils/consoleUtils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#src/utils/consoleUtils.js')>();
  return { ...actual, ...consoleUtilsMock };
});

/**
 * EXT-126 — the `commandEnv` config: the schema carries it with no default, and a passthrough list
 * configured while scrubbing is off makes config loading warn, because such a list does nothing.
 *
 * The warning is checked on the MERGED config in `resolveConfig`, so the cells drive that function
 * rather than a per-layer validator: a global layer turning scrubbing on plus a project layer adding
 * passthrough names is a valid pair, and only the merged view can tell.
 */
describe('EXT-126 — commandEnv config', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const passthroughWarnings = () =>
    consoleUtilsMock.displayWarning.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes('commandEnv.passthrough'));

  describe('schema', () => {
    it('accepts the setting and the passthrough list', async () => {
      const { rawGthConfigSchema } = await import('#src/config/schema.js');
      const result = rawGthConfigSchema.safeParse({
        commandEnv: { scrubCredentials: true, passthrough: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
      });
      expect(result.success).toBe(true);
    });

    it('has no default: an absent commandEnv stays absent after parsing', async () => {
      const { rawGthConfigSchema } = await import('#src/config/schema.js');
      const result = rawGthConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>).commandEnv).toBeUndefined();
    });

    it('rejects a misspelt key rather than dropping it in silence', async () => {
      const { rawGthConfigSchema } = await import('#src/config/schema.js');
      const result = rawGthConfigSchema.safeParse({ commandEnv: { scrubCredential: true } });
      expect(result.success).toBe(false);
    });

    it('rejects a wildcard passthrough entry', async () => {
      const { rawGthConfigSchema } = await import('#src/config/schema.js');
      const result = rawGthConfigSchema.safeParse({
        commandEnv: { scrubCredentials: true, passthrough: ['GOOGLE_*'] },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('resolveConfig warning', () => {
    it('warns when a passthrough list is set and scrubbing is absent', async () => {
      const { resolveConfig } = await import('#src/config/loader.js');
      resolveConfig({ commandEnv: { passthrough: ['GOOGLE_API_KEY'] } }, {});
      const warnings = passthroughWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('GOOGLE_API_KEY');
      expect(warnings[0]).toContain('commandEnv.scrubCredentials');
    });

    it('warns when a passthrough list is set and scrubbing is explicitly off', async () => {
      const { resolveConfig } = await import('#src/config/loader.js');
      resolveConfig({ commandEnv: { scrubCredentials: false, passthrough: ['GH_TOKEN'] } }, {});
      expect(passthroughWarnings()).toHaveLength(1);
    });

    it('CONTROL: does not warn when scrubbing is on', async () => {
      const { resolveConfig } = await import('#src/config/loader.js');
      resolveConfig({ commandEnv: { scrubCredentials: true, passthrough: ['GH_TOKEN'] } }, {});
      expect(passthroughWarnings()).toHaveLength(0);
    });

    it('CONTROL: does not warn with no passthrough list or an empty one', async () => {
      const { resolveConfig } = await import('#src/config/loader.js');
      resolveConfig({}, {});
      resolveConfig({ commandEnv: { passthrough: [] } }, {});
      expect(passthroughWarnings()).toHaveLength(0);
    });
  });
});
