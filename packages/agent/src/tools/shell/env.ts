/**
 * The environment a spawned command receives — the one builder both spawn sites use: the built-in
 * shell tool (`GthDevToolkit`) and custom tools (`GthCustomToolkit`).
 *
 * **Credential scrubbing is opt-in and off by default** (config `commandEnv.scrubCredentials`).
 * With it off, a spawned command inherits the parent's credentials unchanged. That is an accepted
 * risk, not an oversight: anything that prints its environment then puts the operator's keys into
 * the tool result, which is sent to the model provider and saved in session history. Always-on
 * scrubbing cost too much — every command that composes `gth` with itself, and every live-model
 * gate run through the shell tool, found no key and failed with a provider error about the wrong
 * layer. An operator who wants isolation turns scrubbing on.
 *
 * With scrubbing on, {@link isCredentialEnvVar} decides what goes: any name ending in `KEY`,
 * `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or `CREDENTIALS` (any case, with or without an
 * underscore before it), plus {@link CREDENTIAL_BLOCKLIST} for credential names no ending catches.
 * The match is deliberately broad: a missed secret leaks silently, while an over-match (a public
 * `…_PUBLISHABLE_KEY`, a stray `MONKEY`) fails visibly, the failure line names it
 * ({@link describeRemovedOnFailure}), and one `commandEnv.passthrough` entry fixes it. There are
 * no built-in exceptions — GitHub tokens included — so everything a spawned command keeps is named
 * in the operator's own passthrough list. (Gaunt Sloth's own GitHub content and requirement
 * providers call `gh` from the `gth` process itself and never pass through here.)
 *
 * **The setting governs credentials only.** The synthesised `NODE_ENV` drop
 * ({@link SYNTHESIZED_NODE_ENV_MARKER}) happens in every configuration.
 *
 * @module
 */
import { env as processEnv } from '@gaunt-sloth/core/utils/systemUtils.js';
import type { CommandEnvConfig } from '@gaunt-sloth/core/config.js';

/**
 * Explicit blocklist, applied when scrubbing is on, for credential names that no ending in
 * {@link isCredentialEnvVar} catches (`AWS_ACCESS_KEY_ID`, `…_ACCESS_KEY_ID` generally). Names that
 * an ending already catches are listed too, so the list stays a readable record of what the
 * providers Gaunt Sloth can be configured against expect. Matched case-insensitively.
 */
export const CREDENTIAL_BLOCKLIST: ReadonlyArray<string> = [
  // LLM providers
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GROQ_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'OPENROUTER_API_KEY',
  'COHERE_API_KEY',
  'TOGETHER_API_KEY',
  'PERPLEXITY_API_KEY',
  'FIREWORKS_API_KEY',
  // Azure OpenAI
  'AZURE_OPENAI_API_KEY',
  'AZURE_API_KEY',
  // Cloud provider secrets (AWS / GCP)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_ACCESS_KEY_ID',
];

// Any name ENDING in one of these is a credential. No underscore is required before the ending, so
// `OPENAI_APIKEY` and `MYSERVICETOKEN` match as well as `DB_PASSWORD`.
const CREDENTIAL_ENDING = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)$/i;

function includesName(list: ReadonlyArray<string>, name: string): boolean {
  const upper = name.toUpperCase();
  return list.some((entry) => entry.toUpperCase() === upper);
}

/**
 * True when a variable name is credential-shaped: it ends in one of the credential endings, or it
 * is on {@link CREDENTIAL_BLOCKLIST}. Independent of the setting and of any passthrough list.
 */
export function isCredentialEnvVar(name: string): boolean {
  return CREDENTIAL_ENDING.test(name) || includesName(CREDENTIAL_BLOCKLIST, name);
}

/**
 * True when scrubbing, once on, removes this variable: it is credential-shaped and not named in
 * `passthrough` (exact names, case-insensitive, no wildcards).
 */
export function shouldScrubEnvVar(name: string, passthrough: ReadonlyArray<string> = []): boolean {
  return isCredentialEnvVar(name) && !includesName(passthrough, name);
}

/** The resolved form of the `commandEnv` config, with its read-site defaults applied. */
export interface CommandEnvPolicy {
  /** Remove credential-shaped variables. `false` unless the config says exactly `true`. */
  readonly scrubCredentials: boolean;
  /** Names kept while scrubbing is on. */
  readonly passthrough: ReadonlyArray<string>;
}

/** The policy an absent `commandEnv` resolves to: nothing scrubbed. */
export const DEFAULT_COMMAND_ENV_POLICY: CommandEnvPolicy = Object.freeze({
  scrubCredentials: false,
  passthrough: Object.freeze([]) as ReadonlyArray<string>,
});

/**
 * Resolve the `commandEnv` config into a {@link CommandEnvPolicy}. The default lives here, at the
 * read site, rather than in the schema or `DEFAULT_CONFIG`: only an explicit `true` turns scrubbing
 * on.
 */
export function resolveCommandEnvPolicy(config: CommandEnvConfig | undefined): CommandEnvPolicy {
  if (!config) return DEFAULT_COMMAND_ENV_POLICY;
  return {
    scrubCredentials: config.scrubCredentials === true,
    passthrough: [...(config.passthrough ?? [])],
  };
}

/**
 * Marker the CLI entry point (`packages/app/cli.js`) sets alongside a `NODE_ENV`
 * it invented for itself, so React resolves to its production build (TUI-C55).
 *
 * It exists because the value carries no provenance: an operator's own
 * `NODE_ENV=production` is byte-identical to the one we synthesize, and the two
 * must be treated differently — theirs is a deliberate instruction to the whole
 * process tree, ours is an implementation detail of how *we* render. Without the
 * marker, stripping `NODE_ENV` from child environments would quietly discard a
 * setting the operator made on purpose.
 *
 * It is an environment variable rather than module state because it has to cross
 * from `packages/app`'s entry script into this package, which that script cannot
 * import from at the point it runs.
 */
export const SYNTHESIZED_NODE_ENV_MARKER = 'GTH_SYNTHESIZED_NODE_ENV';

/** What {@link buildCommandEnv} produced for one spawn. */
export interface CommandEnv {
  /** The environment to hand to `spawn`. */
  env: NodeJS.ProcessEnv;
  /**
   * Names of the credential variables removed by scrubbing, sorted, in the source's own casing.
   * Empty when scrubbing is off. Never includes the synthesised `NODE_ENV` or its marker, which are
   * not credentials. Names only — never a value.
   */
  removed: string[];
}

/**
 * Build the environment for a spawned command from the parent env (the live `process.env` via
 * systemUtils by default; a source can be injected for testing).
 *
 * In EVERY configuration it drops a `NODE_ENV` we synthesized ourselves (see
 * {@link SYNTHESIZED_NODE_ENV_MARKER}) along with the marker. Our reason for setting it — picking
 * React's production build for the Ink renderer — has nothing to do with the commands the agent
 * runs, and `NODE_ENV=production` changes real behaviour in a child: it makes `npm install` skip
 * devDependencies, and flips framework build and logging defaults. Inheriting it would mean a shell
 * tool invocation behaved differently depending on whether the user happened to be in the TUI. An
 * operator-set `NODE_ENV` has no marker and is passed through untouched. This drop is not governed
 * by `policy`: turning scrubbing off must not bring the synthesised value back.
 *
 * With `policy.scrubCredentials` on, it also removes every variable {@link shouldScrubEnvVar}
 * selects and reports their names in `removed`.
 */
export function buildCommandEnv(
  policy: CommandEnvPolicy = DEFAULT_COMMAND_ENV_POLICY,
  source: NodeJS.ProcessEnv = processEnv
): CommandEnv {
  const synthesizedNodeEnv = Boolean(source[SYNTHESIZED_NODE_ENV_MARKER]);
  const env: NodeJS.ProcessEnv = {};
  const removed: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // The marker is ours and means nothing to a child, so it never travels.
    if (key === SYNTHESIZED_NODE_ENV_MARKER) continue;
    if (key === 'NODE_ENV' && synthesizedNodeEnv) continue;
    if (policy.scrubCredentials && shouldScrubEnvVar(key, policy.passthrough)) {
      removed.push(key);
      continue;
    }
    env[key] = value;
  }
  removed.sort();
  return { env, removed };
}

/**
 * The one line a failed command's tool result carries when scrubbing removed variables from its
 * environment, or `undefined` when nothing was removed (scrubbing off, or nothing matched). It
 * names the variables and the setting, never a value, so a command that failed for want of a key
 * says why instead of surfacing only the child's own error about the wrong layer.
 */
export function describeRemovedOnFailure(removed: ReadonlyArray<string>): string | undefined {
  if (removed.length === 0) return undefined;
  return (
    `Environment: commandEnv.scrubCredentials removed ${removed.join(', ')} from this ` +
    "command's environment; if it needs one of them, add the name to commandEnv.passthrough."
  );
}
