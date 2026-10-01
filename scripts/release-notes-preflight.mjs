#!/usr/bin/env node
// OPS-123 — tell the dispatcher, BEFORE anything is tagged or published, that the release about to
// go out has no notes and will therefore ship a blank GitHub Release body. OPS-59: the notes are
// release-notes/next.md, so "no notes" is that file missing, or carrying nothing under its heading
// (a fresh next.md that no change has added a bullet to). It also warns when the heading names a
// version other than the one shipping — a stale `# v<version>` would become the Release title.
//
// WHAT WENT WRONG WITHOUT IT. OPS-99 ruled that a version nobody wrote notes for ships a BLANK
// body rather than a synthesised list of merged pull requests, because such a list here describes
// whatever happened to arrive as a PR and not the release. That ruling stands and nothing here
// reopens it. What it left behind is silence: both arms of the "Create GitHub Release" step succeed
// identically, so a release dispatched without notes is indistinguishable, from inside the pipeline
// and from the dispatcher's console, from one dispatched with them. Three of four betas shipped
// empty before anyone noticed.
//
// THIS WARNS, IT NEVER BLOCKS. Failing a release on a missing prose file would let a documentation
// omission stop a shipping fix, which is worse than a blank body. Every path here exits 0 — there
// is no `process.exit(<non-zero>)` and no uncaught throw, including on a notes directory that does
// not exist or a package.json that will not parse. The workflow step carries `continue-on-error:
// true` on top of that, and nothing in the workflow consumes this step: it has no `id:`, so no
// later `if:`, `needs:` or output expression can grow a dependency on it and quietly turn the
// advisory into a gate.
//
// THE COST OF FAILING OPEN, AND WHAT PAYS FOR IT. Belt-and-braces non-failure means a mechanism
// that breaks produces silence, which is the exact "nobody finds out" shape this script exists to
// fix. Two things answer that. The crash path is unit-tested rather than merely swallowed
// (packages/core/spec/releaseNotesPreflight.spec.ts drives an absent notes directory and an
// unreadable package.json and asserts exit 0 with a diagnostic). And the OK path is NOT silent: it
// writes a one-line confirmation naming the file it found to the job summary, so the run page shows
// either the warning or the confirmation, and shows NOTHING only when the mechanism itself is
// broken. The confirmation is deliberately not a warning — a warning that fires on every release is
// one nobody reads, which is the control OPS-123 demands.
//
// THE DECISION IS HERE, NOT INLINE IN THE YAML, for the reason scripts/release-notes-for.mjs gives
// for the same split: this runs only during a real release dispatch, so inline bash could be
// verified only by shipping a broken release, while a script is covered by the ordinary unit suite.
// The workflow's own spec (packages/core/spec/releaseNotesWiredIntoRelease.spec.ts) asserts only
// that the job INVOKES this script; whether the warning actually fires is proven by running it.
// Asserting the warning's text against the YAML would be an assertion that cannot fail — it would
// pass whenever the string is present, whatever the job would do.
//
// NO dependencies beyond node: builtins, and no workspace install in the job that runs it. The
// `validate-inputs` job checks out and calls `node` directly; anything else would add a moving part
// to the pipeline's fail-fast gate whose outage could block a release.
//
// THE VERSION IS READ FROM packages/core/package.json — the same file release.yml's "Read CURRENT
// version to ship" step reads. The dispatch inputs (bump / preid / explicit_version) describe the
// POST-bump and say nothing about what ships now, so the version whose notes to check is knowable
// at validate-inputs time from the checked-out repo, with nothing computed. If those two ever read
// different files this check would preflight a version other than the one that ships; the wiring
// spec pins both.
//
// THE SECOND FINDING: A LINK THAT DIES ON PUBLICATION (OPS-147). A relative link in a notes file
// reads correctly in exactly one of the two places it is shown, and which one depends on its shape.
//
// ON THE RELEASE PAGE, GitHub prepends `/<owner>/<repo>/blob/<that release's tag>/` to a
// non-absolute target and THEN NORMALIZES. So a leading `..` climbs past the tag and consumes it:
// `../docs/COMMANDS.md` becomes `blob/docs/COMMANDS.md`, read as ref `docs` and path `COMMANDS.md`,
// and no branch called `docs` exists — 404. That is the bug this node fixed. A target with NO `..`
// resolves there instead: `docs/COMMANDS.md` becomes `blob/<tag>/docs/COMMANDS.md`, which works.
//
// IN THE REPO-FILE VIEW the base is the notes file's own directory, so the two swap places:
// `../docs/COMMANDS.md` resolves to `docs/COMMANDS.md` and works, while `docs/COMMANDS.md` means
// `release-notes/docs/COMMANDS.md`, which does not exist — 404.
//
// SO NEITHER RELATIVE FORM IS RIGHT IN BOTH PLACES, and an absolute URL is the only form that is.
// That is why the check allow-lists absolute targets rather than denying `..`: both relative forms
// are worth flagging, each for its own surface. The failure is silent in the worst direction either
// way, because the link renders, is clickable, and looks right in the source and in every editor
// preview.
//
// It warns on the SAME footing as the missing-notes finding and for the same reason — a link-shape
// complaint must not stop a shipping fix — but it is reported in its own field, so the OPS-123
// control that the notes-present path raises no missing-notes annotation keeps saying what it says.
// It checks link SHAPE and never fetches a URL: the suggested form pins the release's own tag,
// which this dispatch has not created yet, so a link that is correct 404s until the release is cut.
//
// CLI:
//   node scripts/release-notes-preflight.mjs [--version <v>] [--dir <notes dir>]
//                                            [--package-json <path>]
// Prints a summary on stdout, emits a `::warning` workflow command when the notes are missing or
// carry a link that will not survive publication, and — when GITHUB_STEP_SUMMARY is set — appends a
// markdown block to the job summary. Exits 0 always.

import { appendFileSync, readFileSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_NOTES_DIR, NEXT_NOTES_FILE, releaseNotesFor } from './release-notes-for.mjs';

/** The repo root, one level up from scripts/. */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * The package.json the release job reads the shipping version out of. Kept identical to
 * release.yml's `require('./packages/core/package.json').version`, deliberately: this check is
 * worthless if it preflights a version other than the one that ships.
 */
export const DEFAULT_CORE_PACKAGE_JSON = join(REPO_ROOT, 'packages', 'core', 'package.json');

/** The workflow-command annotation title, and the heading the job summary opens with. */
export const WARNING_TITLE = 'Release notes missing';

/** The annotation title for the link finding. Distinct, so the two are told apart at a glance. */
export const LINK_WARNING_TITLE = 'Release notes link check';

/** The annotation title for a heading that names another version. */
export const HEADING_WARNING_TITLE = 'Release notes heading';

/**
 * The version a notes title names, when it opens with a plain version (`v2.1.4`, `v2.1.4 Name`), or
 * undefined for a title that does not start with one — a descriptive heading is the author's call.
 * @param {string} title
 * @returns {string | undefined}
 */
export function titleVersion(title) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(String(title ?? ''));
  return match ? match[1] : undefined;
}

/** The directory name a notes link is resolved against when naming its absolute form. */
const NOTES_DIR_NAME = 'release-notes';

/**
 * Is this markdown link target one that reads correctly in BOTH places a notes file is shown?
 *
 * An ALLOW-LIST of absolute forms, deliberately, rather than a deny-list on `..`. The two relative
 * forms fail on opposite surfaces — `../docs/X.md` on the Release page, `docs/X.md` in the
 * repo-file view — so a rule that looks for `..` would bless the second one, which is broken just
 * as surely, only somewhere else. Anything carrying a URI scheme (`https:`, `mailto:`) or
 * protocol-relative is absolute and fine.
 *
 * A ROOT-RELATIVE target (`/docs/X.md`) is NOT absolute here. A Release body prefixes it like any
 * other, so it renders as `blob/<tag>/docs/X.md` rather than addressing the site root — measured on
 * docker/compose 1.18.0-rc2, whose `/compose/compose-file.md` renders as
 * `/docker/compose/blob/1.18.0-rc2/compose/compose-file.md`.
 *
 * A bare fragment (`#section`) is left alone: it addresses the Release body itself, which is a
 * different question from this one and not one this check can answer.
 * @param {string} target
 * @returns {boolean}
 */
export function isAbsoluteLinkTarget(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#');
}

/**
 * Every inline markdown link in `text` whose target will not survive publication, with the
 * 1-based line it sits on.
 *
 * Fenced code blocks are skipped — a link written out as an EXAMPLE is not a link. The scan is
 * line-by-line and the pattern holds no nested quantifier, so it cannot backtrack catastrophically
 * on a long line.
 *
 * The angle-bracket target form (`[x](<a/path with spaces.md>)`) IS matched, brackets stripped —
 * without that it yielded a truncated target at the first space and a suggestion built from
 * nonsense.
 *
 * NOT matched, and none appears in this directory today: reference-style definitions
 * (`[label]: ../docs/X.md`), raw HTML anchors, and a link whose target spans a line break. All
 * break the same way; extend this if any is ever used here.
 * @param {string} text
 * @returns {Array<{ line: number, target: string }>}
 */
export function relativeLinksIn(text) {
  /** @type {Array<{ line: number, target: string }>} */
  const found = [];
  const lines = String(text ?? '').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Two alternatives, neither nested, so the scan stays linear: `(<...>)` or a bare target.
    const pattern = /\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|([^)\s]*))/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const target = match[1] ?? match[2];
      if (target && !isAbsoluteLinkTarget(target)) found.push({ line: i + 1, target });
    }
  }
  return found;
}

/**
 * The repository's web URL, read off the same manifest the version comes from so an organisation
 * rename cannot leave a hardcoded owner behind.
 *
 * Returns undefined rather than throwing on anything unexpected: a warning that can still name the
 * file and the offending link is worth more than a check that died computing a suggestion.
 * @param {string} [packageJsonPath]
 * @returns {string | undefined}
 */
export function repoWebUrl(packageJsonPath = DEFAULT_CORE_PACKAGE_JSON) {
  try {
    const { repository } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const url = typeof repository === 'string' ? repository : repository?.url;
    if (typeof url !== 'string') return undefined;
    const web = url.replace(/^git\+/, '').replace(/\.git$/, '');
    return /^https:\/\/[^\s/]+\/\S+$/.test(web) ? web : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The repo-root-relative path a relative notes link is reaching for.
 *
 * Which base applies depends on the shape, because the two relative forms are written for
 * different surfaces and each is meaningful on its own:
 *
 *  - a target that does NOT climb is repo-root-relative, because that is exactly what the Release
 *    page does with it: `docs/X.md` renders there as `blob/<tag>/docs/X.md`. Reading it as relative
 *    to `release-notes/` instead would name `release-notes/docs/X.md` — a path that does not exist,
 *    offered as the remedy for a link that already worked on that page;
 *  - a target that climbs (`../docs/X.md`) cannot be root-relative, since it would leave the
 *    repository. It was written for the repo-file view, where the base IS `release-notes/`, so it
 *    is resolved there — recovering `docs/X.md`, which is what its author meant.
 *
 * Leading slashes are stripped first: a Release body prefixes a root-relative target like any
 * other, so `/docs/X.md` is `docs/X.md` with a redundant separator, not a site-root address.
 * @param {string} target the relative link target as written
 * @returns {string | undefined} undefined when the target escapes the repository either way
 */
export function repoPathFor(target) {
  const hash = target.indexOf('#');
  const raw = (hash === -1 ? target : target.slice(0, hash)).replace(/^\/+/, '');
  if (!raw) return undefined;
  const asRoot = posix.normalize(raw);
  if (asRoot && asRoot !== '.' && !asRoot.startsWith('../')) return asRoot;
  const fromNotes = posix.normalize(posix.join(NOTES_DIR_NAME, raw));
  return fromNotes && fromNotes !== '.' && !fromNotes.startsWith('../') ? fromNotes : undefined;
}

/**
 * The absolute URL a relative notes link was reaching for, pinned to the tag this release creates.
 *
 * TAG-PINNED, not `main`. A Release page is a permanent record of one version, so its links should
 * address the tree that version shipped — and a tag is immutable, so a URL verified once stays
 * correct, where a `main` URL decays silently the day a doc is renamed. The consequence, which the
 * howto states: the tag does not exist until the release is cut, so a correct link 404s while the
 * notes are being written. That is why nothing here fetches the URL it suggests.
 * @param {string} target the relative link target as written
 * @param {string} version the version about to ship
 * @param {string | undefined} base the repository web URL
 * @returns {string | undefined} undefined when there is no base, or the target escapes the repo
 */
export function absoluteFormFor(target, version, base) {
  if (!base) return undefined;
  const path = repoPathFor(target);
  if (!path) return undefined;
  const hash = target.indexOf('#');
  const fragment = hash === -1 ? '' : target.slice(hash);
  return `${base}/blob/v${version}/${path}${fragment}`;
}

/**
 * The path to NAME to a human: repo-relative with forward slashes when the file is under the repo,
 * otherwise the path as joined.
 *
 * A dispatcher can act on `release-notes/v2_0_0-beta_13.md`; the absolute path a GitHub runner
 * joins (`/home/runner/work/gaunt-sloth/gaunt-sloth/release-notes/...`) names a directory that no
 * longer exists by the time anyone reads the annotation. Forward slashes unconditionally, so the
 * text is the same on every platform and a spec can assert it without a win32 special case.
 * @param {string} path
 * @param {string} [repoRoot]
 * @returns {string}
 */
export function displayPath(path, repoRoot = REPO_ROOT) {
  const rel = relative(repoRoot, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel.split(sep).join('/');
}

/**
 * Escape a value for the DATA half of a GitHub Actions workflow command.
 *
 * A `::warning::` command is terminated by a newline, so an unescaped one in the message would
 * truncate the annotation and spill the rest into the log as ordinary text — the annotation would
 * still appear, saying less than it was asked to, which is the quiet kind of wrong.
 * @param {string} value
 * @returns {string}
 */
export function escapeData(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

/**
 * The version this dispatch would ship.
 *
 * @param {string} [packageJsonPath]
 * @returns {string} the `version` field
 * @throws when the file is absent or unparseable, or carries no version — callers in the CLI catch
 *   it, because a release must not be blocked by this check failing to run.
 */
export function versionToShip(packageJsonPath = DEFAULT_CORE_PACKAGE_JSON) {
  const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
  if (!version || typeof version !== 'string') {
    throw new Error(`no version field in ${packageJsonPath}`);
  }
  return version;
}

/**
 * The annotation and job-summary block for links that will not survive publication.
 *
 * Both name the file, every offending link with its line, and the absolute form it should have had.
 * A warning a reader cannot act on without opening this script is barely better than no warning.
 * @param {string} notesPath
 * @param {string} version
 * @param {Array<{ line: number, target: string }>} relativeLinks
 * @param {string | undefined} base the repository web URL
 * @returns {{ annotation: string, summary: string }}
 */
function linkFinding(notesPath, version, relativeLinks, base) {
  const where = displayPath(notesPath);
  const count = relativeLinks.length;
  const plural = count === 1 ? '' : 's';
  const suggest = (/** @type {{ line: number, target: string }} */ link) =>
    absoluteFormFor(link.target, version, base);

  const detail = relativeLinks
    .map((link) => {
      const fixed = suggest(link);
      return `line ${link.line}: ${link.target}${fixed ? ` -> ${fixed}` : ''}`;
    })
    .join('; ');

  const message =
    `${where} has ${count} relative link${plural}, and no relative link reads correctly in BOTH ` +
    `places a notes file is shown. On the Release page GitHub prepends ` +
    `/<owner>/<repo>/blob/<this release's tag>/ and normalizes, so "../docs/X.md" climbs past the ` +
    `tag and becomes blob/docs/X.md — a branch called "docs" that does not exist. In the ` +
    `repo-file view the base is release-notes/, so "docs/X.md" means release-notes/docs/X.md, ` +
    `which is not there. Each form is dead exactly where the other works. Write a full https:// ` +
    `URL pinned to this release's tag. ${detail}. ` +
    `This does NOT block the release — but the Release body is a stored copy, so once it is ` +
    `published, fixing the file here does not repair the page.`;

  const bullets = relativeLinks
    .map((link) => {
      const fixed = suggest(link);
      return `- **Line ${link.line}:** \`${link.target}\`${fixed ? ` → \`${fixed}\`` : ''}`;
    })
    .join('\n');

  return {
    annotation: `::warning title=${LINK_WARNING_TITLE}::${escapeData(message)}`,
    summary:
      `## ⚠️ ${LINK_WARNING_TITLE} — ${count} relative link${plural} in a file that is read two ways\n\n` +
      `In \`${where}\`:\n\n${bullets}\n\n` +
      `- **Why:** neither relative form works in both places. On the **Release page** GitHub ` +
      `prepends \`/<owner>/<repo>/blob/<tag>/\` and normalizes, so \`../docs/X.md\` climbs past ` +
      `the tag into \`blob/docs/X.md\` — a branch named \`docs\`. In the **repo-file view** the ` +
      `base is \`release-notes/\`, so \`docs/X.md\` means \`release-notes/docs/X.md\`. Each form ` +
      `is dead exactly where the other works, so only an absolute URL survives both.\n` +
      `- **The suggested tag does not exist yet.** This dispatch creates it, so the corrected link ` +
      `404s until the release is cut and resolves from then on. Do not "fix" it to \`main\`.\n` +
      `- **This does not block the release.** A link-shape complaint must not stop a shipping fix. ` +
      `But the body is stored at publication, so a link left broken stays broken on that page.\n`,
  };
}

/**
 * The whole decision: does the version about to ship have notes, and what should be said about it.
 *
 * `annotation` and `summary` are undefined on the OK path — that is the control OPS-123 asks for,
 * and it is a property of this function rather than of the shell that calls it. `confirmation` is
 * present on both paths so a broken mechanism is distinguishable from a clean release.
 *
 * @param {string} version the version that would ship
 * @param {string} [notesDir]
 * @param {{ repoUrl?: string | undefined }} [options] `repoUrl` overrides the repository web URL
 *   the suggested absolute links are built from; specs pin it so they do not assert against this
 *   repository's own manifest.
 * @returns {{ version: string, notesMissing: boolean, notesPath: string | undefined,
 *   expectedPath: string, expectedDisplay: string, annotation: string | undefined,
 *   summary: string | undefined, confirmation: string,
 *   relativeLinks: Array<{ line: number, target: string }>,
 *   linkAnnotation: string | undefined, linkSummary: string | undefined,
 *   headingAnnotation: string | undefined }}
 */
export function releaseNotesPreflight(version, notesDir = DEFAULT_NOTES_DIR, options = {}) {
  const { notesPath, notesMissing, bodyEmpty, title } = releaseNotesFor(version, notesDir);
  const expectedPath = join(notesDir, NEXT_NOTES_FILE);
  const expectedDisplay = displayPath(expectedPath);
  const named = notesMissing ? undefined : titleVersion(title);
  const headingAnnotation =
    named && named !== version
      ? `::warning title=${HEADING_WARNING_TITLE}::${escapeData(
          `${expectedDisplay} opens with "# ${title}", but this dispatch ships ${version}. The ` +
            `heading becomes the Release title, so the page would be titled for the wrong ` +
            `version. Correct the heading, or carry on if it is deliberate.`
        )}`
      : undefined;

  if (!notesMissing && !bodyEmpty) {
    const found = /** @type {string} */ (notesPath);
    // The WHOLE file, not the body `releaseNotesFor` returns: the body has the H1 removed, so its
    // line numbers would not be the ones in the file a dispatcher opens, and an unactionable line
    // number is worse than none.
    const relativeLinks = relativeLinksIn(readFileSync(found, 'utf8'));
    const base = options.repoUrl ?? repoWebUrl();
    const finding = relativeLinks.length
      ? linkFinding(found, version, relativeLinks, base)
      : { annotation: undefined, summary: undefined };
    return {
      version,
      notesMissing: false,
      notesPath,
      expectedPath,
      expectedDisplay,
      annotation: undefined,
      summary: undefined,
      confirmation: `Release notes preflight: ${version} will publish with the body in ${displayPath(found)}.`,
      relativeLinks,
      linkAnnotation: finding.annotation,
      linkSummary: finding.summary,
      headingAnnotation,
    };
  }

  const what = notesMissing
    ? `There is no ${expectedDisplay}`
    : `${expectedDisplay} has nothing under its heading`;
  const message =
    `${what}, so ${version} will publish with an EMPTY GitHub Release body. It does NOT block ` +
    `the release: add a bullet per user-facing change to ${expectedDisplay} and re-dispatch, or ` +
    `ship blank deliberately.`;

  return {
    version,
    notesMissing,
    notesPath,
    expectedPath,
    expectedDisplay,
    annotation: `::warning title=${WARNING_TITLE}::${escapeData(message)}`,
    summary:
      `## ⚠️ ${WARNING_TITLE} — this release would ship a blank body\n\n` +
      `${what}, so version \`${version}\` has no notes.\n\n` +
      `- **The notes for a release accumulate in** \`${expectedDisplay}\`: a bullet per ` +
      `user-facing change, written before the change merges.\n` +
      `- **This does not block the release.** A missing prose file must not stop a shipping fix. ` +
      `Cancel and fill in \`${expectedDisplay}\` if the notes were simply forgotten; carry on if ` +
      `the blank body is deliberate.\n`,
    confirmation: message,
    // There is no body, so there is nothing to check the links of. The two findings are mutually
    // exclusive by construction, not by accident.
    relativeLinks: [],
    linkAnnotation: undefined,
    linkSummary: undefined,
    headingAnnotation,
  };
}

// CLI.
// Guarded so importing this module (e.g. from the vitest spec) never runs it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // One line, because it is quoted into a workflow-command annotation below, where a newline
  // terminates the command and would truncate the message.
  const usage =
    'usage: release-notes-preflight.mjs [--version <v>] [--dir <notes dir>] ' +
    '[--package-json <path>]';
  try {
    const args = process.argv.slice(2);
    let version;
    let notesDir = DEFAULT_NOTES_DIR;
    let packageJsonPath = DEFAULT_CORE_PACKAGE_JSON;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--version') version = args[++i];
      else if (args[i] === '--dir') notesDir = args[++i];
      else if (args[i] === '--package-json') packageJsonPath = args[++i];
      else throw new Error(`unknown argument: ${args[i]} (${usage})`);
    }

    const result = releaseNotesPreflight(version ?? versionToShip(packageJsonPath), notesDir);
    process.stdout.write(`${result.confirmation}\n`);
    if (result.annotation) process.stdout.write(`${result.annotation}\n`);
    if (result.linkAnnotation) process.stdout.write(`${result.linkAnnotation}\n`);
    if (result.headingAnnotation) process.stdout.write(`${result.headingAnnotation}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      const block =
        result.summary ??
        `## Release notes preflight\n\n${result.confirmation}\n\n` +
          `No action needed — this line is here so a run page showing neither this nor a ` +
          `warning means the preflight itself did not run.\n`;
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        result.linkSummary ? `${block}\n${result.linkSummary}` : block,
        'utf8'
      );
    }
  } catch (error) {
    // Deliberately terminal: this check must never be the reason a release does not ship. The
    // diagnostic is a `::notice`, not a `::warning`, so it cannot be mistaken for the missing-notes
    // finding — it says the check did not run, not that the notes are absent.
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`Release notes preflight could not run: ${reason}\n`);
    process.stdout.write(
      `::notice title=Release notes preflight skipped::${escapeData(reason)} — the release is ` +
        `unaffected, but nothing checked whether it has notes. Check release-notes/ by hand.\n`
    );
  }
  // No exit code is set on any path, deliberately. See the docblock.
}
