# Migrating to 2.0

Gaunt Sloth 2.0 is a **breaking config release**. The config schema is now validated
strictly (via a single Zod source of truth), and there is **no back-compat coercion** for
the old shapes. If you are coming from a 1.x config, read this page before you upgrade.

**Not every break is a config-schema change.** Section N covers the ones that are not — the
`gth api` server's defaults, which no config key describes and which `gth config validate`
therefore cannot check for you.

The fastest way to check a migrated config is:

```bash
gth config validate
```

It validates your effective config against the 2.0 schema **without** building an LLM or
running anything. Unknown top-level keys (likely typos) print a warning but do not fail; a
deprecated config-file shape or a real schema violation prints a path-scoped message and
exits non-zero. Use `gth config print` to see the fully-resolved config (secrets redacted)
after your edits.

## Upgrading from `gaunt-sloth-assistant` (1.x)?

The 2.0 line ships under a **renamed package**, `gaunt-sloth` — not `gaunt-sloth-assistant`,
which is the 1.x package name. Read this section before you run the install command, not
after.

**If `gaunt-sloth-assistant` is still installed globally, installing `gaunt-sloth` on top of
it can fail outright.** 2.0 no longer ships a `gaunt-sloth-assistant` bin — it declares three
bins (`gth`, `gsloth`, `gaunt-sloth`) — but the 1.x package owns those same names too, so
`npm i -g gaunt-sloth` can still hit `npm error EEXIST` on a bin shim the old package already
owns, and the **entire install aborts** — not just that one shim. The `npm rm -g` step below
is only needed by users who still have the 1.x `gaunt-sloth-assistant` package installed.

Confirmed via automated Windows CI (`windows-latest`, run
[29638001306](https://github.com/pukeko-robotics/gaunt-sloth/actions/runs/29638001306)):
after the failed install, `gth`/`gsloth`/`gaunt-sloth --version` (PowerShell *and*
`cmd.exe`) all kept silently reporting the **old 1.x version**, with no further error
surfaced — a user who doesn't notice the failed `npm i` output itself would have no other
sign they're still on 1.x. That CI run only exercised `windows-latest`; other platforms
were not separately verified either way, so treat the fix below as the safe, universal step
regardless of platform:

```bash
npm rm -g gaunt-sloth-assistant
npm i -g gaunt-sloth
gth --version   # should now report a 2.x version
```

Remove the old package **first**, then install the new one — do not install `gaunt-sloth`
while `gaunt-sloth-assistant` is still present.

## Severity at a glance

Every deprecated config-file shape is now a HARD error: 2.0 has no back-compat coercion, so
gth aborts on the old shape with a path-scoped message naming the replacement. Fix all of
these before you upgrade.

**Two migrations meet on this page, and the `From` column says which one each row belongs
to.** Most readers arrive from a 1.x config, but the 2.0 alpha and beta line retired shapes of
its own, and a row about one of those names a key a 1.x config never had. Unlabelled, those
rows send a 1.x reader hunting through their config for settings that cannot be there, with no
way to tell whether they are safe or looking in the wrong place.

- **1.x** — the shape worked in 1.x. Check your config for it.
- **1.x (inert)** — 1.x accepted the key into the file and never acted on it, so a 1.x config
  can carry it while nothing you ever observed came from it. 2.0 aborts rather than ignoring
  it, so it still has to go.
- **2.0 pre-GA** — the shape existed only in a 2.0 alpha or beta. A 1.x config cannot contain
  it, so skip the row. These rows are here because alpha and beta upgraders read this page too.

### HARD (gth aborts, or scripts break)

| Change | From | What breaks | Fix |
| --- | --- | --- | --- |
| `rating` is now an object | **1.x** | `rating: false` (or any boolean) is a validation abort: `expected object, received boolean` | `rating: { enabled: false }` |
| `output.header` is a three-rung enum, defaulting to `compact` | **2.0 pre-GA** | A boolean is a validation abort: `output.header: no longer a boolean: it is one of none, compact, debug.` 1.x had no `output` key at all, so only an alpha/beta config can hit this. The *default* it now takes does change what a 1.x run prints — that half is in the no-error list below, and in section K | `"none"` for `false`, `"debug"` for `true` (see section K) |
| Command configs must nest under `commands.*` | **1.x (inert)** | A top-level command key (e.g. `pr`) is a validation abort: `Top-level command config "pr" is no longer supported in 2.0. Move it under "commands.pr".` 1.x already read command settings only from `commands.*`, so a top-level block sat in the file doing nothing | Move it under `commands.<cmd>` — and check what it says, since 1.x was not applying it |
| Per-command `devTools` folded into `builtInTools` | **1.x** | `commands.<cmd>.devTools` is a validation abort: `Config property "devTools" in commands.code is no longer supported in 2.0. Configure tools under "builtInTools" instead.` | Move the dev/shell tools into the `builtInTools` registry (see section G) |
| Approval knobs moved off `run_shell_command` | **2.0 pre-GA** | `yolo` / `judge` / `allowlist` / `persistAllowlist` on that entry are a validation abort: `Config property "yolo" in builtInTools.run_shell_command is no longer supported in 2.0. Use "approvals": "bypass" instead.` 1.x shipped no `run_shell_command` tool and none of these keys | Move them into the top-level `approvals` setting (see section I) |
| Approvals became one ladder of five modes | **2.0 pre-GA** | `approvals.strictness` / `.escalate` / `.allowlist` / `.persistAllowlist`, an object-form `rater`, and the `mode` value `ask` are all validation aborts, each naming what to use instead. 1.x had no `approvals` block and no approval gate | Pick a mode: `manual` · `write` · `assisted` · `auto` · `bypass` (see section I) |
| `projectGuidelines` / `projectReviewInstructions` folded into `prompts` | **1.x** | Either key is a validation abort: `Config property "projectGuidelines" was renamed in 2.0. Use "prompts.guidelines" instead.` | `prompts.guidelines` / `prompts.review` (see section H) |
| Deprecated `*Provider*` config keys | **1.x** | `contentProvider` / `requirementsProvider` (and the `*ProviderConfig` variants) are rejected: `Config property "contentProvider" was renamed in 2.0. Use "contentSource" instead.` | Rename to `contentSource` / `requirementSource` (and `*SourceConfig`) |
| `--content-provider` / `--requirements-provider` CLI flags removed | **1.x** | Scripts passing those flags error out | `--content-source` / `--requirements-source` (`-p` still aliases `--requirements-source`) |
| `ContentProviderType` / `RequirementsProviderType` type exports removed, and the runtime `contentProvider` / `requirementsProvider` fields removed | **1.x** | TypeScript / programmatic configs that import those types or read those fields fail to compile or resolve | Use `contentSource` / `requirementSource` (and their `string` types) |
| The `gaunt-sloth` app package no longer exports modules (its `exports` map keeps only `./package.json`) | **1.x** | Any `import ... from 'gaunt-sloth/<path>'` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; the CLI binaries (`gth`, `gsloth`, `gaunt-sloth`) are unaffected | Import from the scoped packages instead: `@gaunt-sloth/core`, `@gaunt-sloth/agent`, `@gaunt-sloth/review` (see each package's README for the embed surface) |
| `binaryFormats` accepts `image`, `file` and `audio` only | **1.x** | A `video` or `binary` entry is a validation abort: `binaryFormats.1.type: "video" is not a binary format type any model provider can receive.` | Remove a `video` entry; move a `binary` entry's extensions under `file` (see section M) |
| The `deep` agent backend removed | **2.0 pre-GA** | `agent.backend: "deep"` is a validation abort: `Agent backend "deep" is no longer supported: Gaunt Sloth ships one agent backend.` 1.x had no `agent` block and no second backend to name | Remove the `agent` block, or set `"backend": "lean"` (see section J) |
| `@gaunt-sloth/agent` exports removed with the `deep` backend | **2.0 pre-GA** | `import { GthDeepAgent, gthDeepAgentFactory, … } from '@gaunt-sloth/agent'` no longer resolves, and neither do the `@gaunt-sloth/agent/core/GthDeepAgent.js` / `deepAgentPermissions.js` / `gthAcpServer.js` / `modules/acpModule.js` deep paths. The package itself is new in 2.0; 1.x shipped no `@gaunt-sloth/agent` | Nothing replaces them. `extractDebugRequestExtras` moved to `@gaunt-sloth/agent/core/debugCapture.js`; `startAcpServer` is still a root export and now starts Gaunt Sloth's own ACP server; the rest have no successor (see section J) |

### No error (nothing tells you at load time)

These change what gth does without failing validation, so `gth config validate` cannot warn you
about any of them. The same `From` labels apply.

| Change | From | What moved |
| --- | --- | --- |
| Arrays replace instead of merging across config layers (section D) | **2.0 pre-GA** | 1.x read one config file plus CLI overrides and had no global layer, so no array of yours ever merged across layers. The global + project layering is itself new in 2.0 |
| `writeOutputToFile` defaults to `false` (section E) | **1.x** | 1.x defaulted to `true` and wrote a `gth_<timestamp>_<COMMAND>.md` for every command. Nothing is written now unless you opt in |
| `output.header` defaults to `"compact"` (section K) | **1.x** | The key is new, so a 1.x config cannot set it — but what a 1.x run *printed* changes anyway. 1.x always opened with the Workdir/Model/Tools/Middleware preamble and the interrupt hint; a 2.0 text run opens with one attribution line |
| Session history is on, and writes to `~/.gsloth/history.db` (section L) | **1.x — new, not a flip** | 1.x had no session history at all, so nothing was being recorded before. For an alpha or beta config this is a default moving from off to on. Read section L before deciding: it stores tool results verbatim |
| The AG-UI server binds loopback (section N) | **1.x** | `gth api ag-ui` bound every interface in 1.x and binds `127.0.0.1` now, so a client on another machine — and some clients on *this* machine — can no longer reach it |
| `builtInTools` defaults to `["gth_checklist", "gth_grep"]` (section G) | **1.x — additive** | 1.x had no default: leaving `builtInTools` unset loaded no built-in tools at all. An unchanged config now gets two. This one gives you something rather than taking it away, so there is nothing to fix — set `"builtInTools": []` if you want the 1.x behaviour back |

---

## A. Command configs nest under `commands.*` (HARD)

In 2.0 the per-command settings (`pr`, `review`, `ask`, `chat`, `code`, `exec`, `api`)
live under a top-level `commands` object. A leftover top-level command key is now a hard
validation error that aborts the run, naming the fix:
`Top-level command config "pr" is no longer supported in 2.0. Move it under "commands.pr".`
(A genuinely-unrelated unknown top-level key, i.e. a real typo, still just warns; only the
known command names hard-fail.)

**1.x read command settings from `commands.*` too**, so the nesting itself is not new. What
changed is what happens to a top-level block: 1.x left it in the file and quietly ignored it,
where 2.0 aborts. **So if you find one, read it before you move it** — whatever it says has not
been taking effect, and moving it under `commands.*` turns settings on for the first time.

Before:

```json
{
  "llm": { "type": "anthropic" },
  "pr": {
    "requirementSource": "github"
  }
}
```

After:

```json
{
  "llm": { "type": "anthropic" },
  "commands": {
    "pr": {
      "requirementSource": "github"
    }
  }
}
```

## B. `rating` is now an object (HARD)

The old boolean shorthand for disabling review rating is gone. `rating` (under a command,
e.g. `commands.pr.rating` / `commands.review.rating`) is now an object:
`{ enabled?, passThreshold?, maxRating?, minRating?, errorOnReviewFail? }`. A boolean value
fails schema validation and aborts the run with `Invalid configuration ... expected object,
received boolean`.

Before:

```json
{
  "commands": {
    "pr": {
      "rating": false
    }
  }
}
```

After:

```json
{
  "commands": {
    "pr": {
      "rating": { "enabled": false }
    }
  }
}
```

If you were relying on the default (rating on), you do not need to add anything; only an
explicit `rating: false` (or `rating: true`) needs migrating.

## C. `*Provider*` names renamed to `*Source*` (HARD)

The historical `*Provider*` naming was renamed to `*Source*` across the board, and every
form of it is now a hard break: config-file keys, CLI flags, and TypeScript types.

**Config file keys (HARD).** In `.gsloth.config.*` the old keys are now rejected with a
validation error that names the replacement (e.g. `Config property "contentProvider" was
renamed in 2.0. Use "contentSource" instead.`). There is no one-way remap bridge anymore,
so rename them. The renames:

- `contentProvider` -> `contentSource`
- `requirementsProvider` -> `requirementSource`
- `contentProviderConfig` -> `contentSourceConfig` (root level)
- `requirementsProviderConfig` -> `requirementSourceConfig` (root level)

The per-command blocks accept the two source keys (`contentSource`, `requirementSource`);
the `*SourceConfig` companions live at the config root.

Before:

```json
{
  "contentProvider": "file",
  "requirementsProvider": "jira",
  "requirementsProviderConfig": {
    "cloudId": "...",
    "displayUrl": "https://your-org.atlassian.net"
  }
}
```

After:

```json
{
  "contentSource": "file",
  "requirementSource": "jira",
  "requirementSourceConfig": {
    "cloudId": "...",
    "displayUrl": "https://your-org.atlassian.net"
  }
}
```

**CLI flags (HARD).** The `--content-provider` and `--requirements-provider` flags are
removed. Update any scripts or CI to the new flags:

- `--content-provider` -> `--content-source`
- `--requirements-provider` -> `--requirements-source`

The short alias `-p` is preserved and still maps to `--requirements-source`, so
`gth pr -p github 123` keeps working.

Before:

```bash
gth pr --requirements-provider jira --content-provider file 123
```

After:

```bash
gth pr --requirements-source jira --content-source file 123
```

**TypeScript / programmatic configs (HARD).** The `ContentProviderType` and
`RequirementsProviderType` type exports are removed, and so are the runtime
`contentProvider` / `requirementsProvider` fields on the config object. Code that imports
those types or reads those fields will not compile / resolve. Use `contentSource` /
`requirementSource` (typed as `string`) instead.

Before:

```ts
import type { ContentProviderType } from '@gaunt-sloth/core';

export async function configure() {
  return {
    contentProvider: 'file' as ContentProviderType,
    requirementsProvider: 'jira',
  };
}
```

After:

```ts
export async function configure() {
  return {
    contentSource: 'file',
    requirementSource: 'jira',
  };
}
```

## D. Array merge policy across config layers (behaviour change)

**From a 2.0 alpha or beta.** 1.x resolved a single config file and merged it only with CLI
overrides — there was no global layer — so a 1.x config has nothing here to re-check. The
global + project layering described below is a 2.0 feature; this section is about how its
arrays combine.

When both a global config (`~/.gsloth/...`) and a project config are present, they are
deep-merged (project wins). In 2.0, arrays **replace** by default instead of merging across
layers. The only exceptions are the genuinely-cumulative lists, which still concatenate and
de-duplicate:

- `allowDirs`
- `aiignore.patterns`
- `approvals.deny` and `approvals.escalate` — wherever they appear, including under
  `commands.<cmd>.approvals`. These are the rules you forbid, and a prohibition another layer can
  quietly delete is not a prohibition, so no layer can narrow another's, only add to them.
  `approvals.allow` is **not** additive: it is the permissive list, so it keeps replace semantics
  and a layer that states its own replaces the layer below.

Every other array (`allowedTools`, `builtInTools`, `tools`, `middleware`, `binaryFormats`,
and so on) is now taken wholesale from the higher-precedence layer. So if you were leaning
on a global config to contribute, say, extra `allowedTools` that got unioned with the
project list, that no longer happens: define the full set in the layer that should own it.

This is not a validation error and `gth config validate` will not flag it. It only matters
when you split config across the global and project layers. `gth config print` shows the
final merged result, which is the quickest way to confirm the effective arrays.

## E. `writeOutputToFile` now defaults to `false` (behaviour change)

In 1.x every command wrote its response to a timestamped `gth_<timestamp>_<COMMAND>.md`
file (under `.gsloth/` or the project root) unless you turned it off. These files
accumulate quickly — especially from interactive `chat`/`code` sessions, whose transcript
you already saw live — so in 2.0 the default flips: **nothing is written to disk unless you
opt in.**

`writeOutputToFile` still accepts the same values; only the default changed:

- `false` (new default) — no output file is written
- `true` — restores the old behaviour (standard `gth_<timestamp>_<COMMAND>.md` name)
- a string — a custom path, unchanged (see [Configuration → Output files](configuration/output.md#controlling-output-files))

**If you relied on the auto-saved files** (for example, a CI job that reads back the review
output), set it explicitly:

```json
{
  "writeOutputToFile": true
}
```

**If your CI already passes an explicit value** — a string path like `"reviews/last.md"` or
`writeOutputToFile: true`, whether in config or via `-w/--write-output-to-file` — nothing
changes; those configs keep working exactly as before. This flip only affects setups that
were leaning on the implicit `true` default.

## F. New in 2.0 (additive, nothing to migrate)

These are new capabilities, not breaking changes, but they are useful while migrating:

- **Up-tree project-config discovery.** Gaunt Sloth walks up from the current directory to
  find the project config, stopping at the git root, your home directory, or the filesystem
  root (whichever comes first). You can run it from a subdirectory of your project.
- **TypeScript config (`.gsloth.config.ts`).** A `configure()`-exporting `.ts` config is
  now supported (loaded via jiti), alongside `.json`, `.js`, and `.mjs`.
- **Generated JSON Schema + `$schema` editor support.** The config shape is published as a
  JSON Schema, and you can add a `$schema` key to your JSON config for editor autocomplete
  and validation. The `$schema` key is allowed by the schema and never read at runtime.
- **`gth config validate` and `gth config print`.** Validate a migrated config against the
  2.0 schema (`validate`), or inspect the fully-resolved config with secrets redacted
  (`print`, add `--json` for machine-readable output). Both honour `--config` and
  `--identity-profile`.

## G. `devTools` folded into `builtInTools` (HARD)

**The `devTools` key itself is a 1.x shape**; the shell entries in the example below are not —
they arrived in a 2.0 prerelease. Both are covered here, and the note after the example says
which is which.

The dev tools used to be split across two keys: `builtInTools: string[]` (which built-in tools
are on) and a per-command `commands.<cmd>.devTools` (how the `run_*` commands were configured).
2.0 unifies both into a single **`builtInTools` registry**. A leftover `commands.<cmd>.devTools`
is now a hard validation error:
`Config property "devTools" in commands.code is no longer supported in 2.0. Configure tools under
"builtInTools" instead.`

`builtInTools` now accepts an **object** (keyed by tool name) in addition to the string array. The
object's values enable (`true`), force-disable (`false`), or configure (an object) each tool. The
`run_*` dev-command tools take `{ "command": "…" }`; the shell tool takes its execution knobs
(`enabled` / `timeout` / `maxOutputBytes`). Approval settings — including the top-level
`shellYolo` a 2.0 prerelease had — moved to the top-level `approvals` block instead (section I).

Before:

```json
{
  "builtInTools": ["gth_checklist"],
  "commands": {
    "code": {
      "devTools": {
        "run_tests": "npm test",
        "run_lint": "npm run lint-n-fix",
        "shell": { "enabled": true, "timeout": 300000 },
        "shellYolo": true
      }
    }
  }
}
```

After:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "gth_checklist": true,
        "run_tests": { "command": "npm test" },
        "run_lint": { "command": "npm run lint-n-fix" },
        "run_shell_command": { "enabled": true, "timeout": 300000 }
      }
    }
  },
  "approvals": { "mode": "bypass" }
}
```

Notes:
- **Coming from 1.x, `devTools` held only `run_tests`, `run_lint`, `run_build` and
  `run_single_test`**, each a bare command string. The `shell` entry and `shellYolo` in the
  example above were never 1.x keys — they are there for alpha and beta upgraders, who did have
  them. If your config predates 2.0, migrate the four `run_*` entries and ignore the rest.
- The object form (like the array form) **replaces** the default set, which is
  `["gth_checklist", "gth_grep"]` — list both if you want to keep them. Naming only
  `"gth_checklist": true` silently drops `gth_grep`.
- `run_shell_command` is **ON by default in `code` mode** (still human-gated); turn it off with
  `{ "run_shell_command": false }`.
- The string-array form still works for tools that need no configuration
  (`"builtInTools": ["gth_checklist", "gth_web_fetch"]`).

## H. Flat prompt keys folded into the `prompts` object (HARD)

The flat `projectGuidelines` and `projectReviewInstructions` keys are removed. Prompt-file
config now lives in one `prompts` object whose segments
(`backstory | guidelines | system | chat | code | exec | review`) each accept a string path or
an object `{ path?, enabled?, mode? }` — see
[Configuration → Prompts](configuration/prompts.md#prompt-files-prompts). A leftover flat key is
a hard validation error naming the replacement:
`Config property "projectGuidelines" was renamed in 2.0. Use "prompts.guidelines" instead.`

Before:

```json
{
  "projectGuidelines": "AGENTS.md",
  "projectReviewInstructions": "REVIEW.md"
}
```

After:

```json
{
  "prompts": {
    "guidelines": "AGENTS.md",
    "review": "REVIEW.md"
  }
}
```

**`gth init` no longer plants template files.** In 1.x, `init` (and the first-run dialog)
copied starter `.gsloth.guidelines.md` and `.gsloth.review.md` files into your project; the
guidelines template made the assistant nag about filling it in. 2.0 writes only
`.gsloth.config.json`: review behaviour is unchanged (the bundled review prompt is a complete
real prompt), and guidelines default to empty until you create the file — or point
`prompts.guidelines` at one you already have (e.g. `AGENTS.md`). Existing planted files keep
working; they are simply no longer created for you.

## I. Approvals and the auto-rater (HARD)

**Coming from 1.x, there is nothing in this section to migrate — but read the ladder anyway.**
1.x shipped no shell tool, no `approvals` block and no approval gate: its dev tools were four
fixed `run_*` commands you configured yourself, and nothing asked you before running one. Every
retired key below (`yolo`, `judge`, `allowlist`, `persistAllowlist`, `strictness`, an object-form
`rater`, the `mode` value `ask`) belongs to a 2.0 alpha or beta. A 1.x config cannot contain any
of them, so **do not go looking for them in yours** — but approvals now gate the shell tool 2.0
adds, so the five modes and the two behaviour notes at the end of this section are new behaviour
you will meet.

**Coming from a 2.0 prerelease**, the rest of this section is your migration. Approvals used to
hang off the `run_shell_command` entry of `builtInTools` — the object shared by **every** built-in
tool, so a nonsensical `"gth_grep": { "yolo": true }` validated happily. There is now a single
top-level `approvals` setting, and every retired key is a hard validation error naming its
replacement.

`approvals` is **one ordered ladder of five modes**. Each mode fully determines behaviour: there are
no severity thresholds, no strictness levels, and no independent rater switch.

| # | Mode | Rater |
| --- | --- | --- |
| 1 | `manual` | no |
| 2 | `write` | no |
| 3 | `assisted` (the default) | yes |
| 4 | `auto` | yes |
| 5 | `bypass` | no |

`write` is a variant of `manual` rather than a step of its own: the same posture, with edits inside
your working folder granted as well as reads. The choice you are really making is
`manual` → `assisted` → `auto`, plus `bypass`.

### Old → new

Every `Old` spelling here is a 2.0 alpha/beta key. None of them existed in 1.x.

| Old | New |
| --- | --- |
| `builtInTools.run_shell_command.yolo: true` | `"approvals": "bypass"` |
| `builtInTools.run_shell_command.judge: true` | `"approvals": "assisted"` |
| `judge.model` | `approvals.rater` — an **identity profile name**, not a raw model block |
| `judge.autoApproveLow: false` / `judge.blockHigh` | gone — the mode decides; there are no per-tier knobs |
| `builtInTools.run_shell_command.allowlist` | `approvals.allow` — a declared list of command prefixes |
| `builtInTools.run_shell_command.persistAllowlist` | gone — persistence is a per-decision choice at the prompt (*approve* forgets, *always approve* persists) |
| `approvals.mode: "ask"` | `approvals.mode: "write"` (the agent still edits files freely) or `"manual"` (it asks before writing too) |
| `approvals.rater: { profile: "x" }` | `approvals.rater: "x"` |
| `approvals.rater.strictness` | gone — choose a mode instead |
| `approvals.rater.escalate` | gone — both `assisted` and `auto` escalate everything not rated safe |
| `approvals.allowlist` / `approvals.persistAllowlist` | `approvals.allow` / gone (as above) |
| `run_shell_command` keeps | `enabled`, `timeout`, `maxOutputBytes` |

The rater's scale changed with it: `safe` / `caution` / `danger` / `critical` became **four
outcomes** — `safe`, `destructive`, `catastrophic` and `attack`.

| Outcome | What it means | What happens |
| --- | --- | --- |
| `safe` | no harmful effect | runs without asking |
| `destructive` | harmful, but undoable from inside the session — **the catch-all**, including anything the rater cannot assess | asks you |
| `catastrophic` | cannot be undone from inside the session (`mkfs`, `DROP DATABASE`, `terraform destroy -auto-approve`) | asks you every time; *session* and *always* do not stick |
| `attack` | the command's own structure shows something hostile — a credential targeted for its own sake, privilege escalation, persistence, an impersonated hostname, obfuscation | ends the run |

Pushing and publishing to a destination your project already configures (`git push`, `npm publish`,
`docker push`) is ordinary work: it may be rated `destructive` and asked about, but it never ends
the run. To let a halted command run anyway, declare it in `approvals.allow` — that list is checked
before the rater.

Before:

```json
{
  "commands": {
    "code": {
      "builtInTools": {
        "run_shell_command": {
          "allowlist": false,
          "judge": { "enabled": true, "autoApproveLow": false, "blockHigh": true }
        }
      }
    }
  }
}
```

After:

```json
{ "approvals": "assisted" }
```

Or, if you want to name the rater's model and declare what it may and may not run:

```json
{
  "approvals": {
    "mode": "assisted",
    "rater": "safety-rater",
    "allow": [
      { "type": "shell", "matcher": "exact", "pattern": "npm test" },
      { "type": "shell", "matcher": "glob", "pattern": "git status*" }
    ],
    "deny": [
      { "type": "shell", "matcher": "glob", "pattern": "npm publish*" },
      { "type": "shell", "matcher": "glob", "pattern": "git push --force*" }
    ]
  }
}
```

Every entry in `allow`, `deny` and `escalate` is one explicit object — `type`, `matcher` and
`pattern` are always required, and a bare string is a config error whose message shows you the
object to write instead. The fields are listed in
[Shell tool & approvals](guides/shell-tool-and-approvals.md).

**Two behaviours to expect** — new if you are coming from 1.x, changed if you are coming from a
2.0 prerelease.

1. **The default is `assisted` everywhere**, interactive or not, and it does not vary with the
   configured model. Clearly-safe commands run without a prompt, and each gated command costs one
   rater model call. To confirm every command yourself instead, set `"approvals": "write"`.
2. **Where there is nobody to ask, an escalation exits non-zero.** A CI run, a one-shot
   `gth exec` or a server fails loudly — printing the command, its rating and the reason — rather
   than continuing without the command. Declare what the pipeline may run in `approvals.allow`,
   which is checked before the rater and therefore never escalates.

See [Shell tool & approvals](guides/shell-tool-and-approvals.md).

## J. The `deep` agent backend and the ACP server (HARD)

**Coming from 1.x, nothing here is a migration.** 1.x had no `agent` config block, no second
backend to name, and no `@gaunt-sloth/agent` package — all three arrived in the 2.0 prerelease
line and the backend was retired inside it. The ACP server described at the end of this section
is likewise new in 2.0, not a replacement for anything 1.x had.

Gaunt Sloth's optional second agent backend, `deep`, was a wrapper around a third-party agent
runtime. It is gone, and with it the only ACP (Agent Client Protocol) server implementation, which
was built on it.

### `agent.backend: "deep"`

A config still naming it **fails to load**:

```
Agent backend "deep" is no longer supported: Gaunt Sloth ships one agent backend.
Use "lean" — the only backend there is. …
```

Remove the `agent` block, or set `"backend": "lean"`. It is a hard error rather than a silent
fallback on purpose: a config asking for `deep` is asking for behaviour that no longer exists, and
running a different agent without saying so would surface later as an unexplained change in what
the agent can do.

What actually changes, if you were using it:

| What `deep` provided | Where you stand now |
| --- | --- |
| Subagent dispatch (the `task` tool) | Not available. `subagents` stays a valid config key and a run that declares one says so, but nothing spawns them. |
| Automatic history summarization | Not available. |
| Large-tool-result offload to a file | Not available; oversized tool results are truncated instead. |
| The toolset, the composed system prompt, the approvals gate, `gth_checklist`, `gth_grep` | Unchanged — these were never `deep`-only. |

### Removed exports (embedders)

`@gaunt-sloth/agent` is the embed surface, so the backend's classes went with it. The root export
no longer carries `GthDeepAgent` / `GthDeepAgentParams`, `gthDeepAgentFactory`, `startAcpServer` /
`StartAcpServerOptions`, or the permission-mapping surface (`buildPermissions`,
`guardFilesystemBackend`, `allowDirsToPermissions`, `aiignoreToPermissions`,
`filesystemModeToPermissions`, `FILESYSTEM_TOOL_NAMES`, `DEEP_AGENT_BUILT_IN_TOOL_NAMES`,
`PermissionConfigSlice`, `RealpathGuardOptions`, `FilesystemPermission`). The matching deep paths —
`@gaunt-sloth/agent/core/GthDeepAgent.js`, `core/deepAgentPermissions.js`,
`core/gthDeepAgentFactory.js`, `core/gthAcpServer.js`, `core/subagentProfiles.js`,
`core/subagentThoughtRedaction.js`, `modules/acpModule.js` — are gone too.

One of them has a new home rather than no home: **`extractDebugRequestExtras`** was exported from
`core/GthDeepAgent.js` and lives at **`@gaunt-sloth/agent/core/debugCapture.js`** (re-exporting
`@gaunt-sloth/core`). It was never backend-specific.

`resolveAgentFactory` is unchanged and still the way to hand `GthAgentRunner` a backend; it now
resolves to the lean agent for every input.

Two smaller removals in the same family: `setAcpShellWorkDir`
(`@gaunt-sloth/agent/tools/shell/workDir.js`) is gone — an ACP session roots its whole toolset at
the session's `cwd` rather than the shell alone — and `AGENT_BACKEND_SCOPE_DOCS_URL`
(`@gaunt-sloth/core/core/GthAgentRunner.js`) pointed at a docs section describing which commands
honour a key that now has one value.

### The ACP server

`gaunt-sloth-acp` and `gaunt-sloth --acp-agent` serve the
[Agent Client Protocol](https://agentclientprotocol.com/) over stdio, on Gaunt Sloth's own agent.

**They speak both ACP v1 and ACP v2**, and the version is chosen from the host's own `initialize`
rather than configured — so an editor that speaks either connects with no setting to change. v1 is
the stable protocol every shipping ACP editor uses today, Zed included; v2 is a draft.

Two things follow from the rebuild that were not true of the earlier, `deep`-backed server. A
gated tool now reaches the editor as a `session/request_permission` request, so a shell command
the approvals gate stops is answered in the host instead of silently doing nothing. And the
session's `cwd` roots config discovery and the whole toolset, so the agent reads and writes in the
project the host named.

One agent process serves one workspace: a `session/new` naming a different `cwd` is refused rather
than silently re-rooting the sessions already running. Hosts spawn an agent per project, which is
the shape this serves.

If you would rather not use ACP: `gth api` runs the AG-UI server for a programmatic front door, and
`gth chat` / `gth code` run in a terminal.

## K. `output.header` is a three-rung enum (HARD)

**Which half applies depends on where you are coming from.** The `output` key is new in 2.0, so
only an alpha or beta config can hit the validation error below — a 1.x config had no way to set
it. **The default this key now takes does change what a 1.x run prints**, though, and that half is
in *The default moved to `"compact"`* below. Read that part whichever migration you are on.

`output.header` accepted a boolean, so the only way to quieten the run header was to remove all of
it — including the line saying who reviewed this and with which model. It is now one of `none`,
`compact` or `debug`, and a boolean fails validation with a message naming its replacement:

- `false` → `"none"` — nothing at all, including the `review`/`pr` attribution block that the
  boolean's `false` left in place. This is the one difference in behaviour rather than spelling: if
  you set `false` to keep captured stdout diffable and still want the review labelled, you want
  `"compact"`.
- `true` → `"debug"` — the full Workdir/Model/Tools/Middleware preamble, unchanged.

### The default moved to `"compact"` — this changes output for configs that set nothing

`"compact"` is the new rung and it is now the default, so **a config that never set `output.header`
gets different output in 2.0** — which includes every 1.x config, since 1.x always printed the full
preamble and had no key to turn it down. A non-TUI text run — `ask`, `exec`, `eval`, `review`,
`pr`, anything piped or in CI — opens with one line naming the command and the model that served
it:

```text
Gaunt Sloth · ask · gemini-3.1-pro (google-genai)
```

The Workdir/Model/Tools/Middleware preamble and the `Press Escape or Q to interrupt` hint are no
longer printed unless you ask for them. Set `output.header: "debug"` to restore them:

```json
{
  "output": {
    "header": "debug"
  }
}
```

Esc/Q interruption stays armed in interactive terminal runs whether or not the hint is shown, and
the interactive TUI is unaffected — it always renders the full preamble. If you parse or diff
captured stdout, `"none"` remains the byte-clean rung. See
[Configuration → Run header](configuration/output.md#run-header-outputheader).

## L. `history.enabled` now defaults to `true` (behaviour change)

**Coming from 1.x this is a new feature that is on, not a default that flipped.** 1.x recorded no
session history at all and had no `history` key, so nothing about your runs was being stored
before. Coming from a 2.0 alpha or beta, history existed and was off unless you asked for it.

Either way the result is the same and worth a decision: **every run writes to
`~/.gsloth/history.db` on your own machine** unless you turn it off.

What goes in there:

- one row per turn — the prompt, the response, the command, the model, and token/tool counts — which
  is what `gth history list` / `search` / `show` and `gth insights` read back; and
- for interactive `chat` / `code` sessions, the conversation's own state, so a session can be picked
  up again with its context intact rather than started over.

**The second one is the broader of the two, and worth reading before you decide.** A session's state
is what the agent was actually working with, so it includes **tool results verbatim** — the contents
of files that were read, the output of commands that were run, what an MCP server returned. It is
stored as-is and not redacted, because a session that came back with its evidence edited would no
longer be the session you left. If your work reads material you would rather not have sitting in a
local database, use the switch below to turn recording off.

**It stays on your machine.** Nothing here touches the network, there is no telemetry, and the store
is a directory of plain SQLite databases under your home directory that you can inspect or delete
at any time.

To turn it off — no recording, no stored conversation state, and runs behave exactly as they did:

```json
{
  "history": {
    "enabled": false
  }
}
```

To keep it on but put the store elsewhere, set `history.dbPath`. A config that already sets
`history.enabled` either way is unaffected; only configs that never mentioned the key change
behaviour.

**What reclaims the space, since it now accumulates for everyone.** Conversation state that no
conversation can reach — what `/clear` leaves behind, a session that ended before recording
anything, a conversation marked unresumable because a write failed — is deleted automatically at the
end of a session, a day after its last step. The session running the sweep never reclaims a
conversation it wrote itself; anything else is protected only by that one-day window, so a session
left open in another window and idle for longer can lose its state while it is still on screen.
Nothing there was resumable, so nothing is lost. **State you could still have resumed is only ever removed by
`gth history prune`, which you type**, with an explicit `--older-than <days>` or `--keep-last <n>`
and a plan printed before anything goes; it takes whole conversations and keeps their transcripts,
so `gth history show <id>` goes on working and only the resume stops. `gth history list` prints the
store's size and `gth insights` breaks it down.

## M. `binaryFormats` accepts `image`, `file` and `audio` only (HARD)

`binaryFormats` also took `video` and `binary`, and neither could reach a model. Every provider
builds its request through one LangChain converter that recognises image, audio and file blocks and
rejects anything else, so a config naming either validated, `gth_read_binary` read the file, and the
run then failed at the provider — with a message naming a LangChain block type rather than the file
you attached. Both are now refused at load, naming the entry that carries them:

```text
Invalid configuration in .gsloth.config.json:
  - binaryFormats.1.type: "video" is not a binary format type any model provider can receive. …
```

- **`video` has no replacement.** No provider accepts a video attachment through Gaunt Sloth;
  remove the entry.
- **`binary` becomes `file`.** `binary` was a catch-all bucket, consulted only after every other
  entry failed to match the extension; `file` is the type that actually reaches a model, and the one
  PDFs already use. Move those extensions onto your `file` entry — noting that it matches in order
  with the rest rather than last. **If the `binary` entry carried its own `maxSize` or `mimeTypes`,
  retype that entry to `file` instead of merging it**, since both settings live on the entry rather
  than on the type: merging drops them and silently adopts the other entry's cap and mappings.
  Whether a provider then accepts the file's MIME type is its own decision, and one it tells you
  about.

```json
{
  "binaryFormats": [
    { "type": "image", "extensions": ["png", "jpg"] },
    { "type": "file", "extensions": ["pdf", "bin"] }
  ]
}
```

## N. `gth api` server defaults (behaviour changes, no validation error)

Sections A–M are all config-schema shapes, and `gth config validate` checks every one of them.
**It cannot check anything in this section.** These are server defaults and argument handling, not
keys — so a config that validates cleanly still meets both, and nothing tells you at load time.
**Both apply when you are coming from 1.x.**

### The AG-UI server binds loopback

`gth api ag-ui` used to call `listen` with a port and no host, which binds **every** network
interface — so an agent endpoint that carries no authentication accepted connections from anything
that could route to the machine, while its startup banner said `localhost`. It now binds
`127.0.0.1` by default.

**The banner now names the address and port actually bound**, rather than the ones asked for. That
also fixes `--port 0`, which asks the OS to choose a port: it used to announce
`http://localhost:0`, an endpoint nothing can connect to, while the socket was listening somewhere
else entirely.

**One `listen` binds one address**, which is why the fix depends on which client you have:

| Your client | Pass | What that binds |
| --- | --- | --- |
| On another machine — a phone, a second dev box, a container network | `--host 0.0.0.0` | Every IPv4 network interface. **Exposes an unauthenticated endpoint to the network** |
| On another machine, and you need IPv6 as well | `--host ::` | Every interface, both families. **Also a network interface**, with the same exposure |
| On this machine, dialling `localhost` where that resolves to `::1` | `--host ::1` | IPv6 loopback — still this machine only |
| On this machine, dialling `127.0.0.1` or an IPv4 `localhost` | nothing; this is the default | IPv4 loopback |

**The third row is the one to read twice.** The new default is **IPv4** loopback, so a client on
your own machine that dials `http://localhost:<port>`, resolves the name to `::1` and does not
fall back to IPv4 now gets a connection refused. It looks like the server never started, and the
banner's "only clients on this machine can reach it" reads as though a bind change could not be
your problem. **The fix for that is `--host ::1`, not `--host 0.0.0.0`** — the latter does work,
and pays for a loopback problem by re-opening an unauthenticated endpoint to the network.

**No value serves both loopbacks and nothing else.** `::1` refuses a client dialling `127.0.0.1`
exactly as the default refuses one dialling `::1`, and the only address covering both families is
`::`, which is a network interface too. Pick the family your client actually uses.

**`commands.api.host` is the same setting in the config file** — the one to reach for where
passing a flag by hand is not the shape of the fix, such as a service unit, a container image, or
a script whose command line you do not control:

```json
{
  "commands": {
    "api": {
      "host": "::1"
    }
  }
}
```

`--host` wins over `commands.api.host`, which wins over the `127.0.0.1` default.

### `--port` no longer truncates a value that is not a whole number

`--port` went through a bare `parseInt`, which stops at the first character that is not a digit and
keeps what it has. **`--port 8080abc` became `8080`**, and the server started normally on a port
nobody asked for — with the banner naming the truncated number, so nothing on screen looked wrong.
It is refused at parse time now.

**This matters where the port is computed or templated rather than typed** — a CI variable that
picked up a stray suffix, a launcher interpolating a value that is not quite a number. A run that
succeeds on the wrong port is the kind of failure that surfaces much later, as a client that cannot
reach the port it was told to use.

Only that silent case changes. A value truncating to something unusable failed before and fails
now, and a wholly non-numeric `--port abc` was already refused — it reached `listen` as `NaN` and
came back as `options.port should be >= 0 and < 65536. Received type number (NaN)`.

## Interactive slash commands (renames)

**All of these are 2.0 pre-GA renames.** A 1.x `chat`/`code` session understood exactly one slash
command, `/exit` (and the bare word `exit`), and had no TUI — every command named below arrived in
the 2.0 prerelease line and was renamed inside it. Coming from 1.x there is nothing to unlearn:
`/exit` still works, and the rest is new. Coming from a 2.0 alpha or beta, this is your list.

Inside `chat`/`code` sessions (both the TUI and the plain `--no-tui` readline surface, which now
share one command registry):

- `/tools` renamed to `/verbose` — same tool-detail toggle. `/tools` is removed (no alias; 2.0 is
  a deliberate break, and every retired spelling is named with its replacement rather than aliased).
- `/mode` removed — its output is folded into `/status`.
- `/quit` added as an alias of `/exit`.
- `/yolo`, `/auto-approve` and `/bypass-approve` are **removed** (no aliases). `/approvals <mode>`
  replaces all three: `/approvals bypass` for the first two's unconditional behaviour, and
  `/approvals write` to confirm every command yourself. There is no toggle — with five ordered
  modes a flip has no unambiguous meaning, which is also why `/auto-approve off` could not survive:
  it had to mean one of two different modes.
- `/approvals` shows the current mode, the rater and the allow/deny counts, and switches with
  `/approvals manual|write|assisted|auto|bypass`; with no argument on a terminal it also offers a
  picker.

## Migration checklist

Each item carries the same `From` label as the tables above, so you can skip the ones that cannot
apply to you. **Coming from 1.x, work only the `1.x` items** — the `2.0 pre-GA` ones name keys your
config has never had.

1. **1.x** — Convert any `rating: false` / `rating: true` to `rating: { enabled: false }` /
   `{ enabled: true }` (B).
2. **1.x** — Rename `*Provider*` config keys to `*Source*`, update CLI flags in scripts, and update
   any TypeScript that imported the removed provider types (C).
3. **1.x** — If you relied on the auto-saved `gth_<timestamp>_<COMMAND>.md` output files, set
   `writeOutputToFile: true` (or a string path) — the default is now `false` (E).
4. **1.x** — Move any `commands.<cmd>.devTools` into the `builtInTools` registry. From 1.x that is
   the four `run_*` entries, each becoming `{ "command": … }` (G).
5. **1.x** — Rename `projectGuidelines` → `prompts.guidelines` and `projectReviewInstructions` →
   `prompts.review` (H).
6. **1.x** — Remove any `binaryFormats` entry of type `video`, and move a `binary` entry's
   extensions onto your `file` entry (M).
7. **1.x** — If anything imports from `gaunt-sloth/<path>`, move it to `@gaunt-sloth/core`,
   `@gaunt-sloth/agent` or `@gaunt-sloth/review`; the app package no longer exports modules.
8. **1.x** — Decide whether you want local session history, which is new, on by default, and
   writes tool results verbatim to `~/.gsloth/history.db`; set `history.enabled: false` if you do
   not (L).
9. **1.x** — Expect a shorter run header: one attribution line instead of the preamble. Set
   `output.header: "debug"` to keep what you had (K).
10. **1.x** — If you run `gth api ag-ui`, decide the bind. The default is now IPv4 loopback:
    `--host ::1` (or `commands.api.host`) for a local client that dials IPv6, `--host 0.0.0.0` or
    `::` only if another machine must reach it (N). If anything passes `--port` a computed or
    templated value, check it is a whole number: a trailing suffix used to be truncated (N).
11. **1.x (inert)** — Move top-level command keys (`pr`, `review`, `ask`, `chat`, `code`, `exec`,
    `api`) under `commands.*`, and read what they say: 1.x was not applying them (A).
12. **2.0 pre-GA** — Replace every approvals knob — `yolo` / `judge` / `allowlist` /
    `persistAllowlist` on `run_shell_command`, and `strictness` / `escalate` / an object-form
    `rater` on `approvals` — with one of the five modes, plus `approvals.allow` / `.deny` where you
    need them. Rename the retired `mode` value `ask` to `write` if you want file edits in your
    working folder granted, or to `manual` if you want to be asked about those too (I).
13. **2.0 pre-GA** — Convert any `output.header: false` / `true` to `"none"` / `"debug"` (K).
14. **2.0 pre-GA** — Remove `agent.backend: "deep"` (or set it to `"lean"`), and move off the
    removed `@gaunt-sloth/agent` deep exports (J).
15. **2.0 pre-GA** — If you split config across global + project, re-check arrays that used to
    merge (D).
16. **Everyone** — Whichever mode you land on, approvals now gate the shell tool; read the ladder
    in section I. Then run `gth config validate` (and optionally `gth config print`) to confirm the
    result.
