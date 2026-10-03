# Fork planning: how patches are authored, bundled and contributed

This directory exists only on the `planning/mcp-evals` branch of this fork. It holds the plan and tooling for carrying patches to Gaunt Sloth while they are proposed upstream. It is never part of a patch branch or an upstream pull request, and the fork's `main` stays identical to upstream.

- [PATCHES.md](PATCHES.md): the changes proposed, by priority.
- [scripts/](scripts/): bundling scripts.
- [experiments/](experiments/README.md): an offline harness (stub MCP server and scripted model) for checking what `gth eval` records and sends.

## Goals

- Land each patch upstream as a small, reviewable pull request that the maintainer would have written.
- Until it lands, run on a build that contains it, without a registry and without waiting.
- Carry nothing in the fork that is not a candidate for upstream. Fork-only material lives in this directory and nowhere else.

## Repositories and remotes

| Remote | Repository | Role |
|---|---|---|
| `upstream` | `pukeko-robotics/gaunt-sloth` | Upstream, public |
| `origin` | this repository | The fork, public |

## Branches

- **`main`** mirrors `upstream/main` and is only fast-forwarded. Never commit to it.
- **`planning/mcp-evals`**: this directory and nothing else beyond upstream. Update it by merging `main` into it. Fork-only material never goes anywhere else.
- **`patch/pNN-<slug>`**: one branch per patch, numbered as in [PATCHES.md](PATCHES.md), for example `patch/p03-tool-args`. Cut from `main`, so the branch contains no fork-only files. Cut from another patch branch only when it genuinely depends on it, and say so in the pull request. Each branch passes the full checks on its own.
- **`integration`**: `main` plus every open patch branch, merged in dependency order. Generated, never edited by hand, force-pushed. Bundles are built only from it.
- **Tags `bundle/<upstream-version>-fork.N`**: one per bundle, on the integration commit it was built from.

Rules:

- A fix found while working on a patch goes on that patch's branch.
- Rebase patch branches on `main` on a schedule (at each upstream release, and before opening or updating a pull request), not continuously. Small patches keep this cheap.
- When upstream merges a patch, delete its branch and rebuild integration without it. When upstream has released everything carried here, consumers return to published versions.

## Bundles

A bundle is five tarballs (`@gaunt-sloth/core`, `agent`, `review`, `batch` and the `gaunt-sloth` app) versioned `<upstream>-fork.N`. A consumer installs them as direct `file:` dependencies. The packages pin each other by exact version, so all five are always rebuilt together. A git dependency on the monorepo does not work because the packages live in subdirectories.

The scripts take the path of a checkout, so they run from a checkout of the planning branch against a separate checkout or worktree of the integration branch:

| Script | Status | Purpose |
|---|---|---|
| `scripts/pack-bundle.mjs` | exists, tested | Packs the five packages from a built checkout, rewrites the version and the exact `@gaunt-sloth/*` pins inside the packed copies (sources are untouched, so rebases never conflict on version fields), replaces older tarballs in place and prints the dependency lines. `node planning/scripts/pack-bundle.mjs --fork <checkout> --suffix fork.N [--out <dir>] [--skip-build]` |
| `scripts/assemble-integration.sh` | to write | Resets `integration` to `main`, merges each branch listed in `scripts/patches.txt` (one per line, dependency order), and stops on the first conflict naming the branch |
| `scripts/make-bundle.mjs` | to write | Refuses a dirty tree and any branch other than integration; runs `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm run lint` and `pnpm run docs:check`; calls `pack-bundle.mjs` with the next suffix; writes `BUNDLE.json` beside the tarballs (upstream commit, integration commit, each patch branch and commit, build date, suffix); tags the integration commit |

Constraints:

- Node 24 and pnpm 11 or newer. The repository pins its own pnpm version; pnpm switches to it automatically.
- A bundle is about 2.5 MB. A consumer that commits tarballs should replace them in place so history stays small. A private registry removes that cost later and changes nothing else.
- Checked once with a real build at upstream `main` (`2.1.5-fork.2`): `npm install` and `npm ci` both worked, with one deduplicated copy of each package and `gth --version` reporting the bundle version. Re-check with the first real patch.

## Contributing upstream

Per patch:

1. **Talk first when behaviour changes.** Open an issue (or message the maintainer) with the problem, the proposed user-facing behaviour and alternatives, before coding. Patches that add settings or concepts need the design agreed first. Defect fixes and additive recording can go straight to a pull request with a failing test.
2. **Develop on the patch branch**, following the rules below.
3. **Open the pull request from the patch branch** with a description of what changed, why, how it was tested, and follow-ups or risks. One problem per pull request. Describe the use case neutrally; do not reference private repositories or projects. Use `--body-file`, not an inline body.
4. **Make new behaviour opt-in**, with defaults that preserve today's output so existing suites are unaffected.
5. **Add a release-notes bullet** to `release-notes/next.md` for anything a user would notice, from the user's side, per `release-notes/RELEASE-NOTES-HOWTO.md`.
6. **Answer review on the patch branch**, then rebuild integration and cut a new bundle only if the change is needed sooner.
7. **After merge**, delete the branch and rebuild integration.

Order: small independent patches first (1, 3, 4, 6, 14), then those that build on them (5, 7, 8), then the larger design changes (2, 9, 10, 11). Patches that touch the same files (for example 3, 5 and 7 in the check layer) go in one at a time, each rebased on the previous.

## Rules for agents making changes

These apply to every change on a patch branch. The repository documents its own rules; read them before writing code, and treat them as authoritative over anything here.

Required reading: `AGENTS.md` (the project's agent guide; read it in full once, then re-read the sections for the package being changed), `CONTRIBUTING.md`, `TESTING.md` (where a test belongs and how to run it), `docs/DOC-STYLE.md` and `release-notes/RELEASE-NOTES-HOWTO.md`.

### Follow the project, do not invent

- Find the closest existing example of what is being added (a check type, a recorded field, a config key, a setting) and copy its structure: where the type lives, how the suite parser validates it, how the check reports, how docs and schemas list it. Read the whole path from parsing to output before writing anything.
- Use the project's utilities: `#src/*.js` import aliases rather than relative imports, `consoleUtils` for user output (never `console.log`), `systemUtils` for environment and process access, `llmUtils` for models. Keep the boundaries between commands, modules, providers, tools, middleware and core runtime.
- Reuse existing vocabulary for names, error messages, exit codes and output shapes. Do not introduce a pattern when an equivalent exists. If a deviation is unavoidable, explain it in the pull request and ask the maintainer.
- Keep the change scoped: no drive-by refactors, renames or reformatting. Do not edit lock-step versions in source; bundling rewrites them in the packed copies.
- Never commit secrets, tokens or personal data. Check every diff for them.
- Commit messages are plain English: what changed and why, no code or backticks. Write the message to a file with the file-write tool and commit with `git commit -F <file>`; never `git commit -m`, because the shell would execute backticks in the message.

### Code quality

- The result must read as if the maintainer wrote it: well-factored single-purpose functions, types that make invalid states hard to express, no duplicated logic, no dead code, no leftover debugging.
- Comments say what the code does now and, where it is not obvious, why. Match the density of the surrounding code. No history ("previously", "used to"), no ticket or issue narrative, no references to private projects or to this plan, and no restating the line below. An invariant that would be easy to break gets a short comment where it applies.
- Docs are normative: they state what is true now. Update the user-facing docs and anything the docs checks pin, in the same pull request.

### Tests

Behaviour changes need tests in the same pull request. A test that covers only the happy path does not count.

- **Write the failing test first** and watch it fail for the right reason. After the fix, revert the fix once to confirm the test fails again. A test that passes without the fix proves nothing.
- Put unit tests in the package's `spec/` in Vitest, following `AGENTS.md`: reset mocks in `beforeEach()` with `vi.resetAllMocks()`, import the file under test dynamically inside each test, and mock dependencies rather than importing mocked implementations into the tested module. Check the guidance on which module specifier to mock.
- Cover, for each change: the normal case; each documented option; boundary values; absent and empty inputs; malformed input and the exact error message or exit code; and interaction with neighbouring features (for example a new recorded field together with `must_call`, repeats and the reporters).
- For capture and recording changes, add an end-to-end style spec that runs the real eval path against an in-process stub model and MCP server and asserts on the written `results.json` and per-case files. [experiments/](experiments/README.md) is a working starting point.
- Assert specific values, not "does not throw". Keep tests deterministic: no real network, clocks or model calls.
- CI also runs on Windows and macOS: build paths with the platform's separators and avoid line-ending assumptions.
- Run the whole `pnpm test` (it builds first), not only the new spec. The suite includes specs that spawn the built CLI and specs that pin docs and wiring.

### Before pushing

Run `pnpm test`, `pnpm run lint` (zero warnings), `pnpm run docs:check`, and `pnpm run format` when formatted files changed. Then re-read the whole diff as a reviewer would: scope, naming, error paths, docs, release note, and anything CI would reject. Fix what turns up, then push the patch branch.

Do not push, open a pull request or comment on an issue without the owner's go-ahead for that action. A behaviour change the maintainer has not agreed to stays on its branch.

## State and next steps

Done: upstream `main` at `6dc05ac` builds with Node 24 and pnpm 11; `pack-bundle.mjs` works against a real build; the offline harness in [experiments/](experiments/README.md) reproduces the findings in [PATCHES.md](PATCHES.md) tier 0.

Next:

1. Add `scripts/patches.txt`, then write `assemble-integration.sh` and `make-bundle.mjs`.
2. Patch 3 (argument capture), then patch 4 (empty-trace guard). Patch 3 is estimated at about four files; use it to calibrate the build and test loop.
3. Check patch 1's two suspected defects against real Vertex output, since neither reproduced offline. Close the patch if they do not.
4. Discuss patch 2 with the maintainer before coding.
5. Cut the first bundle.
