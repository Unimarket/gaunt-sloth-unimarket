# Release notes howto

**The notes for the release in development live in `next.md`.** Every change a user
would notice adds a short bullet to it **before it merges**, as part of the same pre-merge routine
as the checks and reviews — whoever merges makes sure it is there. Internal work (refactors, tests,
CI) adds nothing. So the notes accumulate while the context exists, instead of being reconstructed
from the git log at release time.

**The release pipeline publishes `next.md`.** Its `#` heading becomes the GitHub Release title and
the rest becomes the Release body. With no `next.md`, or nothing under its heading, the Release has
a blank body — nothing is synthesised to fill it.

**After the publish, the post-bump archives it.** In the same commit that moves `main` to the next
version, `next.md` is saved as `v` + the shipped version with **every dot replaced by an
underscore** + `.md` (`1.1.0` → `v1_1_0.md`, `2.0.0-beta.3` → `v2_0_0-beta_3.md`), and a fresh
`next.md` opens with the next version's heading. The archived files are the record of what each
release said; nothing reads them at release time. Notes for the 0.x line are archived under `v0/`.

**Do not merge into this repository while a release is running.** The post-bump archives the
`next.md` on the commit that shipped; a bullet merged mid-release lands in the wrong version.

**The pipeline says so before it publishes.** `validate-inputs`, the release run's first job, runs
`scripts/release-notes-preflight.mjs`, which warns when `next.md` is missing or has nothing under its
heading, and when its heading names a version other than the one shipping. It warns and never
blocks: a missing prose file must not stop a shipping fix, so the dispatcher decides whether to
cancel and write the notes or let the blank body stand.

## Conventions

- **The H1 is normally just the version**, as in `# v2.0.0-beta.3`, which is what a fresh `next.md`
  opens with. A descriptive suffix — as in
  `# v2.0.0-beta.2 The Alignment Check` — is earned by a release carrying a new feature, or a change
  that is big **to someone using the tool**. Work that was significant to the project and is a
  non-event for a user keeps the flat heading.
- **One bullet per user-facing change**, from the user's side of it: what they can now do, or what
  changed under them. Most releases end at three to seven lines. Concision is the default, not a
  fallback for a release with little in it.
- **Release notes are documentation.** When something genuinely important ships, one or two
  paragraphs for that feature is enough.

A file that is nothing but its H1 is a valid release note: the Release page then shows that title
and nothing under it.

- **While `latest` points at a prerelease, say what that does to a library consumer.** A known-good
  prerelease is deliberately promoted to `latest`, so `npm i @gaunt-sloth/<pkg>` writes a
  `^2.0.0-beta.N` range that admits every later prerelease of the same version — the user is
  subscribed to a line where breaking changes are still permitted, and nothing they typed said so.
  It is not a breaking change and does not belong under that heading; it is a consequence of the
  channel and is worth one bullet on the release that introduces it. Installing the CLI globally is
  unaffected, since that writes no manifest.

- **Every link in a notes file is a full `https://` URL, pinned to that release's own tag.** The
  reason is that **a notes file is read in two places, and neither relative form works in both.**

  On the **Release page**, GitHub prepends `/<owner>/<repo>/blob/<that release's tag>/` to a
  non-absolute target and then normalizes it. So a leading `..` climbs past the tag and consumes
  it: `../docs/COMMANDS.md` becomes `blob/docs/COMMANDS.md`, which names a branch called `docs` and
  returns 404. A target with no `..` resolves there — `docs/COMMANDS.md` becomes
  `blob/<tag>/docs/COMMANDS.md`.

  In the **repo-file view** the base is the notes file's own directory, so the two swap: the `..`
  form recovers `docs/COMMANDS.md` and works, while `docs/COMMANDS.md` means
  `release-notes/docs/COMMANDS.md`, which does not exist.

  Each relative form is therefore dead exactly where the other works, and **only an absolute URL
  survives both.** Write
  `https://github.com/pukeko-robotics/gaunt-sloth/blob/v2.0.0-beta.6/docs/COMMANDS.md#api-ag-ui`.
  The tag is the one this release will create, so **the link returns 404 until the release is cut**
  and resolves from then on; that is expected and is not a reason to repoint it at `main`. A Release
  page is a permanent record of one version and a tag is immutable, so a tag-pinned link stays
  correct where a `main` link decays the day a document is renamed — and it deliberately serves the
  documentation **as that release shipped it**, so an old Release page keeps describing the version
  it belongs to rather than silently acquiring today's docs. The failure is silent in the
  worst direction — the link renders, is clickable, and looks right in the source and in every
  editor preview — so `validate-inputs` warns about one before anything is published, naming the
  file, the link and the URL it should have been. Like the missing-notes warning it never blocks.
  This binds `next.md`, which becomes a Release body, and so the archived `v<version>.md` files; a
  link in this howto is an ordinary repository link and is relative as usual.

## Style

Dry and factual, not excited or marketing-oriented. `v2_0_0-beta_3.md` is the shape to follow.
Write what a user can now do, or what changed under them. Leave out unit tests, integration tests
and other development-specific detail.

## Writing them

- **For each change, before it merges:** if a user would notice it, add a bullet to `next.md`. Not
  necessarily in the same commit as the change — it is part of the pre-merge routine, beside the
  checks and reviews. A conflict in `next.md` between two merges is resolved by whoever merges.
- **For a larger release that deserves a hand-written account:** rewrite `next.md` itself before
  dispatching — sort it into sections, give it a descriptive heading. Never write a separate
  `v<version>.md` for it: `next.md` is the only file a release reads, and the post-bump replaces an
  archive of the same name with what was published.
- **Before dispatching:** read `next.md` through once as a whole, and present it to the user.

## Structure

A short file needs no headings at all — bullets under the H1 are enough, and most releases end
there. A release large enough to sort uses the sections that apply, and only those:

- **New Features**: major functionality additions
- **Potentially Breaking Changes**: changes that require the user to do something
- **Bug Fixes**: resolved issues
- **Improvements**: refactoring, performance, architecture
- **Maintenance**: dependency updates, minor fixes

For a breaking change, say what the user has to do about it.
