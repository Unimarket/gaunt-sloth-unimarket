import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_ENV_POLICY,
  SYNTHESIZED_NODE_ENV_MARKER,
  buildCommandEnv,
  describeRemovedOnFailure,
  isCredentialEnvVar,
  resolveCommandEnvPolicy,
  shouldScrubEnvVar,
  type CommandEnvPolicy,
} from '#src/tools/shell/env.js';

/** EXT-126 — scrubbing on, with an optional passthrough list. */
const scrubOn = (passthrough: string[] = []): CommandEnvPolicy => ({
  scrubCredentials: true,
  passthrough,
});

describe('isCredentialEnvVar (EXT-126 endings + blocklist)', () => {
  it('matches every ending with an underscore before it', () => {
    for (const name of [
      'OURCOOLSTARTUP_KEY',
      'BAR_TOKEN',
      'X_SECRET',
      'DB_PASSWORD',
      'DB_PASSWD',
      'APP_CREDENTIALS',
    ]) {
      expect(isCredentialEnvVar(name), name).toBe(true);
    }
  });

  it('matches every ending with NO underscore before it', () => {
    for (const name of [
      'OPENAI_APIKEY',
      'MYSERVICETOKEN',
      'APPSECRET',
      'DBPASSWORD',
      'DBPASSWD',
      'GCPCREDENTIALS',
    ]) {
      expect(isCredentialEnvVar(name), name).toBe(true);
    }
  });

  it('matches regardless of case', () => {
    for (const name of ['my_service_token', 'Db_Password', 'openai_apikey', 'app_Credentials']) {
      expect(isCredentialEnvVar(name), name).toBe(true);
    }
  });

  it('catches a blocklisted name that no ending catches', () => {
    // Guard: the premise of this cell is that the ending alone would miss it.
    expect(/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)$/i.test('AWS_ACCESS_KEY_ID')).toBe(
      false
    );
    expect(isCredentialEnvVar('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(isCredentialEnvVar('aws_access_key_id')).toBe(true);
  });

  it('still covers the explicit provider credentials', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AZURE_OPENAI_API_KEY',
    ]) {
      expect(isCredentialEnvVar(name), name).toBe(true);
    }
  });

  it('leaves generic dev env alone', () => {
    for (const name of [
      'PATH',
      'HOME',
      'SHELL',
      'LANG',
      'PWD',
      'NODE_ENV',
      'npm_config_registry',
    ]) {
      expect(isCredentialEnvVar(name), name).toBe(false);
    }
  });

  it('has no built-in exception for GitHub tokens', () => {
    expect(isCredentialEnvVar('GITHUB_TOKEN')).toBe(true);
    expect(isCredentialEnvVar('GH_TOKEN')).toBe(true);
  });
});

describe('shouldScrubEnvVar (passthrough)', () => {
  it('keeps exactly the passthrough names, case-insensitively', () => {
    expect(shouldScrubEnvVar('GOOGLE_API_KEY', ['google_api_key'])).toBe(false);
    expect(shouldScrubEnvVar('GEMINI_API_KEY', ['google_api_key'])).toBe(true);
  });

  it('treats a passthrough entry as an exact name, not a pattern', () => {
    expect(shouldScrubEnvVar('GOOGLE_API_KEY', ['GOOGLE_*'])).toBe(true);
    expect(shouldScrubEnvVar('GOOGLE_API_KEY', ['GOOGLE'])).toBe(true);
  });
});

describe('resolveCommandEnvPolicy', () => {
  it('defaults to off when the config is absent', () => {
    expect(resolveCommandEnvPolicy(undefined)).toEqual({
      scrubCredentials: false,
      passthrough: [],
    });
    expect(DEFAULT_COMMAND_ENV_POLICY.scrubCredentials).toBe(false);
  });

  it('is on only for an explicit true', () => {
    expect(resolveCommandEnvPolicy({}).scrubCredentials).toBe(false);
    expect(resolveCommandEnvPolicy({ scrubCredentials: false }).scrubCredentials).toBe(false);
    expect(resolveCommandEnvPolicy({ scrubCredentials: true }).scrubCredentials).toBe(true);
  });

  it('carries the passthrough list', () => {
    expect(
      resolveCommandEnvPolicy({ scrubCredentials: true, passthrough: ['GH_TOKEN'] }).passthrough
    ).toEqual(['GH_TOKEN']);
  });
});

describe('buildCommandEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    ANTHROPIC_API_KEY: 'fixture-anthropic',
    OPENAI_APIKEY: 'fixture-openai',
    GITHUB_TOKEN: 'fixture-github',
    GH_TOKEN: 'fixture-gh',
    OURCOOLSTARTUP_KEY: 'fixture-startup',
    AWS_ACCESS_KEY_ID: 'fixture-aws-id',
  };

  it('with the default policy, inherits every credential unchanged and removes nothing', () => {
    const out = buildCommandEnv(undefined, source);
    expect(out.env).toEqual(source);
    expect(out.removed).toEqual([]);
  });

  it('with scrubbing on, removes every credential and keeps the rest', () => {
    const out = buildCommandEnv(scrubOn(), source);
    expect(out.env).toEqual({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(out.removed).toEqual([
      'ANTHROPIC_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'OPENAI_APIKEY',
      'OURCOOLSTARTUP_KEY',
    ]);
  });

  it('with scrubbing on, removes GITHUB_TOKEN and GH_TOKEN unless they are passed through', () => {
    const removed = buildCommandEnv(scrubOn(), source);
    expect(removed.env.GITHUB_TOKEN).toBeUndefined();
    expect(removed.env.GH_TOKEN).toBeUndefined();

    const kept = buildCommandEnv(scrubOn(['GITHUB_TOKEN', 'gh_token']), source);
    expect(kept.env.GITHUB_TOKEN).toBe('fixture-github');
    expect(kept.env.GH_TOKEN).toBe('fixture-gh');
  });

  it('with a passthrough list, keeps exactly the named variables and removes the rest', () => {
    const out = buildCommandEnv(scrubOn(['OURCOOLSTARTUP_KEY', 'ANTHROPIC_API_KEY']), source);
    expect(out.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'fixture-anthropic',
      OURCOOLSTARTUP_KEY: 'fixture-startup',
    });
    expect(out.removed).toEqual(['AWS_ACCESS_KEY_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_APIKEY']);
  });
});

describe('describeRemovedOnFailure', () => {
  it('names the removed variables and the setting, and never a value', () => {
    const { removed } = buildCommandEnv(scrubOn(), {
      PATH: '/usr/bin',
      MYSERVICETOKEN: 'fixture-value-must-not-print',
      DB_PASSWORD: 'fixture-password-must-not-print',
    });
    const line = describeRemovedOnFailure(removed)!;
    expect(line).toContain('DB_PASSWORD, MYSERVICETOKEN');
    expect(line).toContain('commandEnv.scrubCredentials');
    expect(line).toContain('commandEnv.passthrough');
    expect(line).not.toContain('fixture-value-must-not-print');
    expect(line).not.toContain('fixture-password-must-not-print');
    expect(line).not.toContain('\n');
  });

  it('says nothing when nothing was removed', () => {
    expect(describeRemovedOnFailure([])).toBeUndefined();
  });
});

/**
 * TUI-C55 — the entry point sets `NODE_ENV=production` so React picks its production build, and
 * that is an implementation detail of how *we* render. It must not reach the commands the agent
 * runs, where `NODE_ENV=production` has real consequences (npm skipping devDependencies, framework
 * build and logging defaults flipping).
 *
 * The distinction these cases pin is provenance, not value: an operator's own `NODE_ENV=production`
 * is byte-identical to ours, so only the marker can tell them apart. Both directions are asserted,
 * because a builder that simply always dropped `NODE_ENV` would pass the first case and silently
 * discard a setting the operator made deliberately.
 *
 * EXT-126 — the drop is independent of the credential setting, so every case runs with scrubbing
 * off (the default) AND on.
 */
describe.each([
  ['scrubbing off (default)', DEFAULT_COMMAND_ENV_POLICY],
  ['scrubbing on', scrubOn()],
])('buildCommandEnv — synthesized NODE_ENV (TUI-C55), %s', (_label, policy) => {
  it('drops a NODE_ENV we synthesized, along with its marker', () => {
    const out = buildCommandEnv(policy, {
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      [SYNTHESIZED_NODE_ENV_MARKER]: '1',
    });
    expect(out.env.NODE_ENV).toBeUndefined();
    expect(out.env[SYNTHESIZED_NODE_ENV_MARKER]).toBeUndefined();
    expect(out.env.PATH).toBe('/usr/bin');
    // Not a credential, so never reported as one.
    expect(out.removed).toEqual([]);
  });

  it("preserves an operator's own NODE_ENV, which carries no marker", () => {
    const out = buildCommandEnv(policy, { PATH: '/usr/bin', NODE_ENV: 'production' });
    expect(out.env.NODE_ENV).toBe('production');
  });

  it('preserves an operator NODE_ENV that differs from ours', () => {
    const out = buildCommandEnv(policy, { PATH: '/usr/bin', NODE_ENV: 'staging' });
    expect(out.env.NODE_ENV).toBe('staging');
  });

  /**
   * The demonstration rather than the assertion: a real child process, spawned the way the shell
   * tool spawns one, reporting the environment it actually received. The cases above describe the
   * object we build; this one proves what a spawned program sees.
   */
  it('a really-spawned child does not receive the synthesized NODE_ENV', () => {
    const script = 'process.stdout.write(JSON.stringify(process.env.NODE_ENV ?? null))';

    const synthesized = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: buildCommandEnv(policy, {
        ...process.env,
        NODE_ENV: 'production',
        [SYNTHESIZED_NODE_ENV_MARKER]: '1',
      }).env,
    });
    expect(synthesized.error).toBeUndefined();
    expect(synthesized.status).toBe(0);
    expect(synthesized.stdout).toBe('null');

    // Control: the identical spawn, identical value, no marker — so the difference the child sees
    // is caused by the provenance marker and nothing else.
    const operatorSet = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: buildCommandEnv(policy, { ...process.env, NODE_ENV: 'production' }).env,
    });
    expect(operatorSet.status).toBe(0);
    expect(operatorSet.stdout).toBe('"production"');
  });
});
