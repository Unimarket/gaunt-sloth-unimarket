# Release HOWTO

## Creating npm version

Good habit is to ask Gaunt Sloth to review changes before releasing them:

```bash
git --no-pager diff v0.8.3..HEAD | gth review
```

Make sure `npm config set git-tag-version true`

! Important ! The `files` block of package.json strictly controls what is actually released,
the `files` makes .npmignore ignored.

### Unified, locked versioning

<!-- BEGIN GENERATED release-locked-packages -->

<!-- Written from packages/*/package.json by scripts/sync-package-docs.mjs. Do not edit between
     the markers by hand: change a manifest, or that script, then run
     node scripts/sync-package-docs.mjs --write -->

Five of the seven packages release in lockstep at one version:

- the scoped libraries `@gaunt-sloth/core`, `@gaunt-sloth/agent`, `@gaunt-sloth/review` and
  `@gaunt-sloth/batch`, and
- `gaunt-sloth` — the fat user-facing CLI, whose package name and directory differ (dir
  `packages/app`).

`@gaunt-sloth/eval-reporter-junit` and `@gaunt-sloth/eval-reporter-teamcity` are versioned on
their own track, bumped by hand, and deliberately outside that set — published and git-tagged
alongside it, at their own versions.

<!-- END GENERATED release-locked-packages -->

`packages/core/package.json` is the source of truth for the version. `npm version` does not work
well in workspaces for scoped packages, so use the bump script. Version computation uses
`semver.inc(current, releaseType, preid)` — the same engine npm uses:

```bash
pnpm run release:bump                          # patch-increment core's version AND sync the set
pnpm run release:bump minor                    # patch | minor | major AND sync
pnpm run release:bump prerelease alpha         # walk the prerelease counter on the alpha channel
pnpm run release:bump preminor alpha           # open the next minor's alpha line
pnpm run release:bump 2.0.0-alpha.0            # set an explicit version AND sync
pnpm run release:bump-and-commit <args>        # same, then refresh pnpm-lock.yaml and commit
```

Release types: `patch | minor | major | prepatch | preminor | premajor | prerelease`, plus an
explicit `MAJOR.MINOR.PATCH[-prerelease]`. An optional preid (`alpha | beta | rc`) applies to the
`pre*`/`prerelease` verbs.

The script rewrites each package's `"version"`, the scoped libraries' exact pins on each other,
and the fat CLI's `@gaunt-sloth/*` dependency pins. It also writes `publishConfig.tag` into **every
version-locked** package.json, derived from the new version: a prerelease (`2.0.0-alpha.0`) gets
its preid (`alpha`/`beta`/`rc`) as the tag; a stable version gets `latest`. This is the
`latest`-hijack guard (see below). Commit the result before publishing — `release:bump-and-commit`
does that for you, including the lockfile refresh (`pnpm install --lockfile-only`) that keeps the
next `pnpm install --frozen-lockfile` happy.

### Prereleases never take `latest`

`npm publish` defaults to `--tag latest` for **every** version regardless of any prerelease
suffix. Two guards keep a prerelease (`-alpha`/`-beta`/`-rc`) off `latest`:

1. **`publishConfig.tag`** in each package.json (written by the bump script) — so even a bare
   `npm publish` routes to the prerelease channel.
2. **Explicit `--tag <dist-tag>`** in the release pipeline, derived from the resulting version.

A stable version derives `latest`; a prerelease derives its preid.

### The `eval-reporter-*` tier publishes on `latest` (its own `0.x` track)

The `gth eval` reporter plugins in the `@gaunt-sloth/eval-reporter-*` family — every package
`bump.mjs` leaves out of its version sync — are **independently versioned** (a plain, stable `0.x`)
but are published and git-tagged alongside the locked set. Their dist-tag is therefore derived from
**their own stable version → `latest`**, *decoupled* from the synced set's prerelease channel.

This is automatic: `publish-all.sh` derives **each** package's dist-tag from **that package's own
version** via `scripts/dist-tag.mjs` (stable `0.x` → `latest`; a prerelease → its preid). So a single
release run ships the synced set on `alpha`/`beta`/`rc` and the reporters on `latest` in the same
loop. Each reporter's own `publishConfig.tag` is `latest` too (belt-and-suspenders), so even a bare
`pnpm publish` of a reporter lands on `latest`.

Why it matters: npm sets `latest` automatically only on a package's **first** publish. A reporter
published under `--tag alpha` (as happened to `eval-reporter-teamcity@0.1.1`) leaves `latest` frozen
at the first version, so a user running the README's plain `npm i -D
@gaunt-sloth/eval-reporter-teamcity` (which resolves `latest`) gets the **stale** version. Deriving
the tag per package keeps each reporter's `latest` current (OPS-22). **Never pass `--tag alpha` for a
reporter** — a plain `pnpm publish` is what you want.

### Releasing — the consolidated pipeline (CI, recommended)

**One workflow, [release.yml](../.github/workflows/release.yml), replaces the old `publish.yml`
and `publish-packages.yml`.** Dispatch it from the Actions tab via the "Run workflow" button. It
is `workflow_dispatch` (not `release: published`) so the tag + GitHub Release are created **last**,
only after every gate is green. Job graph:

```
lint+unit  ->  integration-tests (big provider)
           ->  integration-tests-platforms (macOS + Windows)
           ->  tui-e2e (Ink TUI in a PTY; Linux + macOS + Windows)
           ->  evals (gth eval on the judge-free smoke subset)
           ->  release   (ship CURRENT version, THEN post-bump main to next)
```

All four gates run in parallel off `lint+unit`, and `release` needs every one of them — a gate that
is skipped skips the release rather than passing it.

#### Versioning model: "release CURRENT, then post-bump to next"

**The invariant: `main` HEAD always carries the *next* version to publish.** A release run ships
whatever version is currently in `package.json`, and **only after a successful publish** does it
bump to the next version, commit, and push that commit to `main`.

This makes a run **idempotent at the version level**:

- If the publish step fails, the version in `main` is **unchanged** — re-dispatching the workflow
  simply **retries the same version**.
- If the publish succeeds, the version has **moved on** — so the just-shipped version can never be
  re-shipped by a later run.

Step order inside the `release` job:

1. Checkout `main` (`fetch-depth: 0`), setup Node + pnpm (`pnpm/action-setup`), `pnpm install --frozen-lockfile`, configure git identity.
2. **Read the CURRENT version** from `packages/core/package.json` — this is what ships.
3. **Derive the dist-tag** from the *current* version (prerelease suffix → its preid; else `latest`).
4. `pnpm run build`.
5. `./tag-packages.sh --push` — tags the current version (skips already-existing tags, so a
   re-dispatch of the same version is safe).
6. `gh release create v<current>` (`--prerelease` when the current version has a prerelease suffix),
   with the title and body taken from `release-notes/next.md` — see
   [GitHub Release](#github-release).
7. **Publish every package** at the current version, each on the dist-tag derived from its own
   version — `publish-all.sh` does that per package, so the job passes no global `--tag`.
8. **Only after publish succeeds:** post-bump — `pnpm run release:bump-and-commit` driven by the
   dispatch inputs, with `--archive-notes <current>`: the same commit archives
   `release-notes/next.md` as `release-notes/v<current>.md` and opens a fresh `next.md` for the next
   version. Then `git push origin HEAD:main`. Nothing should merge into `main` while this runs.

#### The dispatch inputs describe the POST-bump, not the version shipped

The "Run workflow" form has three inputs. They control the **next** version (the increment applied
*after* this release), **not** the version being released now:

- **`bump`** — the semver verb applied as the post-bump: `patch | minor | major | prepatch |
  preminor | premajor | prerelease | explicit`. **Default `patch`**, which is the ordinary next
  version on a stable line.
- **`preid`** — `n/a | alpha | beta | rc`; only used by the `pre*`/`prerelease` verbs. **Default
  `n/a`**, which means *not a prerelease*: the dispatch drops it rather than passing it on, because
  `bump.mjs` rejects any preid it does not recognise whatever the verb is. A `pre*` verb left at
  `n/a` is refused before anything is published, since the post-bump would otherwise produce a
  channel-less prerelease whose `publishConfig.tag` derives to `latest`.
- **`explicit_version`** — an exact NEXT version (e.g. `2.0.0-alpha.0`); only used when
  `bump = explicit`.

#### One-time seed (before the very first release)

Because a run ships the *current* version, `main` must already carry a version to ship. Seed it
**once**, locally, before the first dispatch:

```bash
pnpm run release:bump-and-commit 2.0.0-alpha.0   # then push main
```

`premajor` from `0.1.8` would yield `1.0.0-alpha.0`, not `2.0.0` — we're skipping a whole major
(0→2) as a one-time unification jump, so the seed is set explicitly. After this seed, the first
dispatch ships `2.0.0-alpha.0` and post-bumps `main` to whatever the inputs say.

#### The lifecycle from one dropdown

With the seed in place, each dispatch ships the version on `main` and leaves the *next* version
there. The "from" column is what `main` carries when you press the button (= what ships); "leaves
on main" is the post-bump result that the **next** run will ship.

| run | from (ships now) | dist-tag | post-bump inputs | leaves on main (ships next) |
| --- | --- | --- | --- | --- |
| seed | — | — | (local) `explicit` `2.0.0-alpha.0` | `2.0.0-alpha.0` |
| 1 | `2.0.0-alpha.0` | alpha | `prerelease` `alpha` (default) | `2.0.0-alpha.1` |
| 2 | `2.0.0-alpha.1` | alpha | `prerelease` `alpha` | `2.0.0-alpha.2` |
| … | … | alpha | `prerelease` `alpha` | … |
| last alpha | `2.0.0-alpha.3` | alpha | `prerelease` `beta` | `2.0.0-beta.0` |
| last beta | `2.0.0-beta.1` | beta | `prerelease` `rc` | `2.0.0-rc.0` |
| last rc (GA prep) | `2.0.0-rc.2` | rc | `patch` *(finalizes)* | `2.0.0` |
| GA | `2.0.0` | **latest** | `preminor` `alpha` | `2.1.0-alpha.0` |
| stable patch | `2.0.0` | latest | `patch` | `2.0.1` |

The key mental shift from a "compute target, then release" model: **channel moves and finalize are
chosen on the run that ships the *last* of the previous channel.** Shipping the last alpha with a
post-bump of `prerelease`+`beta` leaves `2.0.0-beta.0` on `main`, so the next run ships the first
beta. Likewise, finalizing happens by post-bumping with `patch` on the run that ships the last rc —
that run ships `2.0.0-rc.2` and leaves `2.0.0` on `main` for the GA run.

#### Mid-publish npm outage

The version-level idempotency above protects against re-shipping. Within a single run
`publish-all.sh` publishes sequentially, so an npm outage part-way through leaves some packages
live and others not. **Find out which by asking the registry** — `npm view <name> versions` — not
by checking against any list in this document.

Once npm is reachable again, re-dispatching is the recovery. `publish-all.sh` asks the registry
whether each package's current version is already published and skips the ones that are, so the
packages that did ship do not abort the retry. That guard is scoped to
`https://registry.npmjs.org` — the local Verdaccio proxies npmjs and would false-positive — and a
lookup that fails for any reason falls through to attempting the publish, so a re-dispatch made
while the outage is still going still dies at the first unreachable publish. Wait for the
registry, then re-dispatch.

Publishing a straggler by hand at the same current version works too:

```bash
REGISTRY=https://registry.npmjs.org \
  NPM_PUBLISH_ARGS="--access public --provenance --tag <derived>" \
  bash -c 'cd packages/<straggler-package> && pnpm publish --registry "$REGISTRY" --no-git-checks $NPM_PUBLISH_ARGS'
```

Here `<derived>` is that package's OWN channel — `node scripts/dist-tag.mjs <version>` prints it: a
synced-set straggler derives `alpha`/`beta`/`rc`, but a straggler in the `eval-reporter-*` tier
derives `latest` (its stable `0.x`). **Never pass `--tag alpha` for a reporter**; a bare
`pnpm publish` (its `publishConfig.tag` is `latest`) also lands it on `latest`.

Then re-create the tag/release/post-bump steps as needed.

The `release` job uses npm Trusted Publishing (OIDC) — no token. Each package's Trusted Publisher
on npmjs must point at this repo and `release.yml`.

### Releasing manually

Bump and commit first (see above): npm refuses to republish an existing version.

Tags follow the `<name>@<version>` convention (npm monorepo style) and are annotated. The helper
reads each package's current `package.json` and tags every package its own `PACKAGES` array lists.
Read that set there rather than from a list here — a list here can disagree with it, and a package
missing from it ships with no tag at all. Existing tags are skipped, so it's safe to re-run:

```bash
./tag-packages.sh            # create the tags locally
./tag-packages.sh --push     # create and push them (PUSH=1 ./tag-packages.sh also works)
```

Preview what will be included in each package:

<!-- BEGIN GENERATED release-pack-preview -->

<!-- Written from packages/*/package.json by scripts/sync-package-docs.mjs. Do not edit between
     the markers by hand: change a manifest, or that script, then run
     node scripts/sync-package-docs.mjs --write -->

```bash
pnpm --filter @gaunt-sloth/core pack --dry-run
pnpm --filter @gaunt-sloth/agent pack --dry-run
pnpm --filter @gaunt-sloth/review pack --dry-run
pnpm --filter @gaunt-sloth/batch pack --dry-run
pnpm --filter @gaunt-sloth/eval-reporter-junit pack --dry-run
pnpm --filter @gaunt-sloth/eval-reporter-teamcity pack --dry-run
pnpm --filter gaunt-sloth pack --dry-run
```

<!-- END GENERATED release-pack-preview -->

Publish every package in the dependency order `publish-all.sh`'s `ORDER` array declares — read it
there rather than from a list here. The script defaults to a local Verdaccio at
`http://localhost:4873`
(see [CONTRIBUTING.md](../CONTRIBUTING.md#local-development-registry-optional)); set `REGISTRY` to
target npmjs:

```bash
REGISTRY=https://registry.npmjs.org pnpm run release:publish
```

Note: the first ever publish of a scoped package requires `--access public` (pass it via
`NPM_PUBLISH_ARGS="--access public"`). After that it's not needed. `pnpm run release:publish`
derives each package's `--tag` from its OWN version automatically (`scripts/dist-tag.mjs`), so you do
**not** pass a global `--tag` — the synced set gets its prerelease channel and the `eval-reporter-*`
tier gets `latest` in the same run. Only when publishing a **single** package by hand, outside the
script, force its channel with `--tag <alpha|beta|rc>` (a synced-set prerelease) — never for a
reporter, which belongs on `latest`; `publishConfig.tag` covers this either way, the flag is
belt-and-suspenders.

### Test-deploying library packages

See [TEST-DEPLOY.md](TEST-DEPLOY.md) for how to test-deploy `@gaunt-sloth/review`
as a standalone global install before publishing.

## GitHub Release

The consolidated pipeline creates the GitHub Release automatically (`gh release create
v<version>`, with `--prerelease` for prerelease versions). You normally don't create releases by
hand.

**Its title and body come from `release-notes/next.md`**, where each user-facing change added a
bullet before it merged. `scripts/release-notes-for.mjs` takes its `#` heading as the Release title
and passes the rest as the body — so read it through before dispatching. See
[release-notes/RELEASE-NOTES-HOWTO.md](../release-notes/RELEASE-NOTES-HOWTO.md).

With no `next.md`, or nothing under its heading, the Release gets an **empty body**. Nothing is synthesised to fill
it: a body built from merged pull requests describes whatever happened to open one — branches here
land by local merge and usually open none — so it reads as an account of the release while
describing something else. Blank says nothing; that list says something untrue.

**You find that out before it ships, not after.** The `validate-inputs` job runs
`scripts/release-notes-preflight.mjs` at the start of every release run, before anything is tagged,
built or published. When `next.md` on `main` is missing or has nothing under its heading it raises a
warning annotation naming the file, and writes the same to the job summary; otherwise it confirms
which file will be used. It also warns when the heading names a version other than the one
shipping, since the heading becomes the Release title. The annotation stays on the run page, so it is still there at the deploy
approval. **It cannot fail the run** — the step is `continue-on-error`, the script exits 0 on every
path including its own crash paths, and no `id:` on the step lets anything depend on its outcome.
Blocking a release on a missing prose file would let a documentation omission stop a shipping fix,
which is worse than a blank body. Cancel and write the notes, or dispatch again knowing the body
will be blank.

If you ever need to create one by hand:

(if you have multiple accounts in gh, you may need to do `gh auth switch`)

```bash
gh release create v<version> --notes-file release-notes/next.md
```

## Viewing diff side by side

Configure KDE diff Kompare as github difftool

```bash
# Configure default git diff tool
git config --global diff.tool kompare
# Compare all changed files
git difftool v0.9.3 HEAD -d
```

Configure vimdiff

```bash
# Configure default git diff tool
git config --global diff.tool vimdiff
# Compare changed files one by one
git difftool v0.9.3 HEAD
```

## Cleaning up the mess

Delete incidental remote and local tag

```bash
git tag -d v0.3.0
git push --delete origin v0.3.0
```
