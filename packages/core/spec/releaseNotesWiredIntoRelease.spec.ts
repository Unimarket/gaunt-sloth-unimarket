import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * OPS-98 — the hand-written release notes must stay wired into the release job.
 *
 * scripts/release-notes-for.mjs is unit-tested next door, but a script nothing invokes is the
 * failure mode that looks exactly like success: the Release page would go back to a list of merged
 * pull requests and every test would stay green. The helper reaches the release through strings in
 * a workflow file — a `run:` line and two `gh release create` invocations — none of which is
 * type-checked, executed by the unit suite, or referenced from any code path. That is the same
 * "preserved by nothing" problem docsRenderGateWired.spec.ts exists to solve for `docs:check`.
 *
 * Three properties are asserted beyond "the script is called", because each is a way this change
 * could break a release rather than merely undo itself:
 *
 *  - the `gh release view` skip stays, so a re-dispatch after a failed publish does not die;
 *  - a version with no notes file gets an EMPTY body, stated explicitly with `--notes ""`, and
 *    nothing synthesises one for it. `--generate-notes` would fill the page with merged pull
 *    requests, which here describe whatever happened to open one rather than the release — blank
 *    says nothing, that list says something untrue. The empty body is spelled out rather than left
 *    implicit so the step does not depend on `gh` deciding it cannot prompt;
 *  - the run block interpolates no `${{ }}` expression. An expression is spliced into the script as
 *    TEXT before bash parses it, and a release note title may contain a backtick
 *    (release-notes/v1_2_0.md) — which would then run as command substitution inside the release
 *    job. Values reach the block through `env:` instead, where an expanded variable is never
 *    rescanned. A green run cannot review that property; only this can.
 *
 * This asserts facts about the *files*. What the helper itself does is proven by running it, in
 * releaseNotesFor.spec.ts.
 */

const RELEASE_WORKFLOW = new URL('../../../.github/workflows/release.yml', import.meta.url);
const HELPER = new URL('../../../scripts/release-notes-for.mjs', import.meta.url);

const RELEASE_JOB = 'release';
const HELPER_COMMAND = 'node scripts/release-notes-for.mjs';
const RELEASE_STEP = 'Create GitHub Release';

/**
 * One job's text, from its `<id>:` key to the start of the next job. Same slicing as
 * docsRenderGateWired.spec.ts, and the terminator is `[^\s#]` for the same reason: a job id may
 * begin with `_` or be quoted, and against an identifier-shaped pattern the slice would run to end
 * of file, letting another job's steps satisfy an assertion about this one.
 */
function jobText(workflow: string, jobId: string): string {
  const start = workflow.indexOf(`\n  ${jobId}:`);
  if (start === -1) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.search(/\n {2}[^\s#]/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * One step's text within a job, from its `- name: <name>` to the next step at the same indent.
 * Steps in this workflow are indented six spaces.
 */
function stepText(job: string, stepName: string): string {
  const start = job.indexOf(`\n      - name: ${stepName}\n`);
  if (start === -1) return '';
  const rest = job.slice(start + 1);
  const next = rest.search(/\n {6}- /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The shell body of a step's `run: |` block scalar — everything after the `run:` line. */
function runBlock(step: string): string {
  const match = /^[ \t]*run: \|[ \t]*$/m.exec(step);
  if (!match) return '';
  return step.slice(match.index + match[0].length);
}

/**
 * A command at the start of a line inside a block scalar. `^[ \t]*` admits only whitespace before
 * it, so a `#`-commented-out line cannot match — which a plain substring search cannot tell apart
 * from a live one, and commenting a line out is how a step usually gets "temporarily" disabled.
 */
function blockLine(command: string): RegExp {
  return new RegExp(`^[ \\t]*${command}`, 'm');
}

/** A single-line `run: <command>` step, as docsRenderGateWired.spec.ts matches one. */
function runStep(command: string): RegExp {
  return new RegExp(`^[ \\t]*run:[ \\t]*${command}`, 'm');
}

function releaseJob(): string {
  return jobText(readFileSync(RELEASE_WORKFLOW, 'utf8'), RELEASE_JOB);
}

describe('OPS-98 the release notes helper is wired into the release job', () => {
  it('has the helper script', () => {
    expect(existsSync(HELPER), 'scripts/release-notes-for.mjs is missing').toBe(true);
  });

  it('runs the helper as a step of the release job', () => {
    expect(
      runStep(HELPER_COMMAND).test(releaseJob()),
      `the "${RELEASE_JOB}" job in .github/workflows/release.yml must run "${HELPER_COMMAND}" — ` +
        'without it the Release page falls back to a list of merged pull requests and the ' +
        'hand-written release-notes/ file is read by nothing, with every test still green.'
    ).toBe(true);
  });

  it('passes the resolved notes to gh as a title and a notes file', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(step, `the "${RELEASE_STEP}" step has no run block`).not.toBe('');
    expect(
      blockLine('gh release create .*--notes-file "\\$NOTES_BODY_FILE"').test(step),
      'the Release must be created with --notes-file pointing at the body the helper wrote'
    ).toBe(true);
    expect(
      blockLine('gh release create .*--title "\\$NOTES_TITLE"').test(step),
      'the Release title must come from the helper, not from a hardcoded version string'
    ).toBe(true);
  });

  it('creates the Release with an explicitly empty body when there is no notes file', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(step, `the "${RELEASE_STEP}" step has no run block`).not.toBe('');
    expect(
      blockLine('gh release create .*--notes ""').test(step),
      'a version nobody wrote notes for must still create the Release, with an empty body stated ' +
        'as `--notes ""`. Omitting the notes flags instead leaves the body to whatever `gh` does ' +
        'when it decides it cannot prompt, which is not a property this step should rest on.'
    ).toBe(true);
  });

  it('synthesises nothing to fill an empty Release body', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    // Control: an empty slice would satisfy the assertion below for the wrong reason.
    expect(step).toContain('gh release create');
    expect(
      step.includes('--generate-notes'),
      'the Release body is the notes we wrote or nothing. `--generate-notes` fills the page with ' +
        'merged pull requests, and branches here land by local merge and usually open none — so ' +
        'that list describes whatever happened to arrive as a PR, not this release. Blank says ' +
        'nothing; a plausible-looking list of unrelated changes says something untrue.'
    ).toBe(false);
  });

  it('keeps the already-exists skip, so a re-dispatch does not die', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    expect(
      blockLine('if gh release view "v\\$\\{VERSION\\}" >/dev/null 2>&1; then').test(step),
      'a re-dispatch after a failed publish finds the Release already created by the first ' +
        'attempt; without this guard the second run fails on it.'
    ).toBe(true);
  });

  it('interpolates no workflow expression into the release shell', () => {
    const step = runBlock(stepText(releaseJob(), RELEASE_STEP));
    // Control: an empty slice would satisfy the assertion below for the wrong reason.
    expect(step).toContain('gh release create');
    expect(
      step.includes('${{'),
      'a ${{ }} expression is substituted into this block as TEXT before bash parses it, so a ' +
        'release note title containing a backtick would run as command substitution in the ' +
        'release job. Pass the value through `env:` and reference it as a quoted variable.'
    ).toBe(false);
  });

  /**
   * The workflow is one of five places that described the generated-PR-list fallback: the step
   * itself, the helper's docblock, and three documents that tell a human (or an agent) what a
   * release does. Removing the behaviour from the shell while a document still promises it leaves
   * the repository stating something false, and the next person to touch the step reinstates it
   * from the doc. The list is hardcoded rather than a glob: archived notes under release-notes/
   * may name the flag as history, and those files are not ours to rewrite.
   */
  describe('nothing still promises the generated pull request list', () => {
    const FILES = [
      'AGENTS.md',
      'maintenance/RELEASE-HOWTO.md',
      'release-notes/RELEASE-NOTES-HOWTO.md',
      'scripts/release-notes-for.mjs',
      // The second helper's docblock describes the same ruling, so it is a sixth place the
      // generated-PR-list fallback could be promised back into existence. The list is hardcoded
      // rather than a glob, so a new file has to be added here by hand or it is simply not swept.
      'scripts/release-notes-preflight.mjs',
      '.github/workflows/release.yml',
    ];

    it.each(FILES)('%s does not mention --generate-notes', (file) => {
      const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
      // Control: a renamed file throws on the read above, but an emptied or stubbed one would
      // pass the sweep by having no content to fail on — the same result as the sweep succeeding.
      expect(text.length, `${file} is unexpectedly short`).toBeGreaterThan(200);
      expect(
        text.includes('--generate-notes'),
        `${file} still describes the Release body being synthesised from merged pull requests. ` +
          'The release job no longer does that; a document that says otherwise is how the branch ' +
          'gets put back.'
      ).toBe(false);
    });
  });

  it('slices only the named step, not the ones after it', () => {
    // Control for stepText: the step after "Create GitHub Release" publishes to npm, and if the
    // slice ran past the end of the step every assertion above would be reading the wrong text.
    const step = stepText(releaseJob(), RELEASE_STEP);
    expect(step).toContain('gh release create');
    expect(step).not.toContain('release:publish');
  });
});

/**
 * OPS-123 — the pre-dispatch warning stays wired into the job that runs FIRST.
 *
 * OPS-99 made a missing notes file ship a blank Release body rather than a synthesised list of
 * merged pull requests, which was right, and left the silence: both arms of the step above succeed
 * identically, so a release dispatched without notes is indistinguishable from one dispatched with
 * them. Three of the last four betas shipped empty before anyone noticed. `validate-inputs` runs
 * before anything is tagged, built or published, and its annotation persists on the run page
 * through to the `environment: release` approval button.
 *
 * WHAT THIS DOES NOT ASSERT, on purpose: the warning's text. A test that greps this workflow for
 * the warning string passes whenever the string is present in the YAML, whatever the job would
 * actually do — an assertion that cannot fail, and it would be added to close exactly that kind of
 * gap. Whether the warning fires is proven by running the script, in
 * releaseNotesPreflight.spec.ts. What can only be asserted here is that the job calls it at all,
 * and that calling it cannot fail a release.
 */
describe('OPS-123 the release notes preflight is wired into validate-inputs', () => {
  const VALIDATE_JOB = 'validate-inputs';
  const PREFLIGHT_COMMAND = 'node scripts/release-notes-preflight.mjs';
  const PREFLIGHT_STEP = 'Warn if this release would ship a blank GitHub Release body';
  const CHECKOUT_STEP = 'Check out the repo for the release notes preflight';
  const PREFLIGHT_SCRIPT = new URL('../../../scripts/release-notes-preflight.mjs', import.meta.url);

  function validateJob(): string {
    return jobText(readFileSync(RELEASE_WORKFLOW, 'utf8'), VALIDATE_JOB);
  }

  it('slices only validate-inputs, not the jobs after it', () => {
    // Control for jobText, the twin of the stepText control above. `lint-and-unit` follows
    // immediately and every later job checks out; if this slice ever ran long, the checkout
    // assertion below would be satisfied by somebody else's checkout.
    const job = validateJob();
    expect(job).toContain('Validate bump / preid / explicit_version');
    expect(job).not.toContain('uses: ./.github/workflows/unit-tests.yml');
  });

  it('has the preflight script', () => {
    expect(existsSync(PREFLIGHT_SCRIPT), 'scripts/release-notes-preflight.mjs is missing').toBe(
      true
    );
  });

  it('runs the preflight as a step of the first job', () => {
    expect(
      runStep(PREFLIGHT_COMMAND).test(validateJob()),
      `the "${VALIDATE_JOB}" job in .github/workflows/release.yml must run "${PREFLIGHT_COMMAND}" ` +
        '— without it a dispatch that will ship a blank Release body says so nowhere, which is ' +
        'the whole of OPS-123. A script nothing invokes leaves every test green.'
    ).toBe(true);
  });

  it('checks out the repo so the preflight can see release-notes/', () => {
    const step = stepText(validateJob(), CHECKOUT_STEP);
    // Control: an empty slice would satisfy the assertions below for the wrong reason.
    expect(step, `the "${CHECKOUT_STEP}" step is missing`).not.toBe('');
    expect(
      blockLine('uses: actions/checkout@').test(step),
      `the "${VALIDATE_JOB}" job had no checkout before this check existed. Without one the ` +
        'script is not on disk, the step fails, `continue-on-error` swallows it and the dispatch ' +
        'is silent again — the failure this check exists to remove, restored invisibly.'
    ).toBe(true);
    expect(
      blockLine('continue-on-error: true').test(step),
      'this checkout exists only to serve an advisory annotation, so its own failure must not be ' +
        'able to stop a release either.'
    ).toBe(true);
    expect(
      blockLine('persist-credentials: false').test(step),
      'nothing in this job pushes, so the checkout leaves no token on the runner.'
    ).toBe(true);
    expect(
      blockLine('ref: main').test(step),
      "the release job pins `ref: main` and ships main's version whatever ref the dispatch was " +
        'launched from. A preflight on any other ref reports on a version that is not being ' +
        'released — and the dangerous direction is silent: a branch carrying a notes file for its ' +
        'own version makes this step confirm while the release goes out blank.'
    ).toBe(true);
  });

  it('cannot fail the release: the preflight step is continue-on-error', () => {
    const step = stepText(validateJob(), PREFLIGHT_STEP);
    // Control: an empty slice would satisfy a `toContain` for the wrong reason.
    expect(step, `the "${PREFLIGHT_STEP}" step is missing`).toContain(PREFLIGHT_COMMAND);
    expect(
      blockLine('continue-on-error: true').test(step),
      'blocking a release on a missing prose file would let a documentation omission stop a ' +
        'shipping fix, which is worse than a blank body. The script exits 0 on every path; this ' +
        'is the second belt, and it is the one that survives the script being replaced.'
    ).toBe(true);
  });

  it('cannot fail the release: nothing can depend on the preflight step', () => {
    const step = stepText(validateJob(), PREFLIGHT_STEP);
    expect(step, `the "${PREFLIGHT_STEP}" step is missing`).toContain(PREFLIGHT_COMMAND);
    expect(
      /^[ \t]*id:/m.test(step),
      'the preflight step carries no `id:` deliberately: with one, a later `if:`, `needs:` or ' +
        'output expression could grow a dependency on its outcome and quietly turn an advisory ' +
        'into a gate on a missing prose file.'
    ).toBe(false);
  });

  it('preflights the same version the release job ships', () => {
    // The dispatch inputs describe the POST-bump, so the shipping version is read from the repo —
    // and both readers must name the same file or the check is preflighting something else. The
    // script's half of this is asserted in releaseNotesPreflight.spec.ts.
    const step = stepText(releaseJob(), 'Read CURRENT version to ship (and derive its dist-tag)');
    expect(step, 'the release job no longer reads the version in a step by that name').not.toBe('');
    expect(step).toContain('packages/core/package.json');
    // The other half of the same invariant: same FILE (above) and same REF. If the release job
    // ever stopped pinning main, the preflight's own `ref: main` would become the wrong one.
    expect(
      blockLine('ref: main').test(releaseJob()),
      'the release job no longer pins `ref: main`, so the preflight and the release may now read ' +
        'different refs — the preflight would report on a version that is not the one shipping.'
    ).toBe(true);
  });
});

/**
 * OPS-59 — the post-bump archives release-notes/next.md as the version that just shipped and opens a
 * fresh one, in the same commit as the version bump. What the archive does is proven by running it,
 * in releaseNotesArchive.spec.ts; what can only be asserted here is that every bump the post-bump
 * can make passes the flag, and that the flag carries the SHIPPED version — the one the release
 * read its notes for — rather than one of the dispatch inputs, which describe the next version.
 */
describe('OPS-59 the post-bump archives the release notes', () => {
  const POSTBUMP_STEP = 'Post-bump main to the next version (drives bump.mjs from dispatch inputs)';

  function postBump(): string {
    return stepText(releaseJob(), POSTBUMP_STEP);
  }

  it('passes --archive-notes on every bump-and-commit the step can run', () => {
    const block = runBlock(postBump());
    // Control: an empty slice would satisfy the count below for the wrong reason.
    expect(block, `the "${POSTBUMP_STEP}" step is missing`).toContain('release:bump-and-commit');
    const bumps = block
      .split('\n')
      .filter((line) => /^[ \t]*pnpm run release:bump-and-commit/.test(line));
    expect(bumps.length).toBeGreaterThan(0);
    for (const line of bumps) {
      expect(
        line,
        'a post-bump that skips the archive leaves the shipped notes in next.md, where the next ' +
          'release would publish them again under its own version.'
      ).toContain('--archive-notes "$SHIPPED_VERSION"');
    }
  });

  it('archives under the version the release shipped', () => {
    expect(postBump()).toMatch(
      /^[ \t]*SHIPPED_VERSION: \$\{\{ steps\.current\.outputs\.version \}\}$/m
    );
  });
});
