import { afterAll, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * OPS-59 — the post-bump half of the next.md process: after a release ships, release-notes/next.md
 * is archived as that version's notes file and a fresh next.md is opened for the version now in
 * development, in the same commit as the version bump.
 *
 * Two layers. The helper (scripts/release-notes-archive.mjs) is driven directly. Then the real
 * bump.mjs is run, without `--commit`, in a scratch copy of the repo's shape, because the flag is
 * parsed out of the same argv the version spec is read from: a slip there would bump to the
 * shipped version, or reject the run after the publish, and only running it shows which.
 *
 * Paths are asserted through `join()` or bare file names, never a POSIX literal (Windows cell).
 */

const HELPER = '../../../scripts/release-notes-archive.mjs';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const dirs: string[] = [];

function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'notes-archive-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('scripts/release-notes-archive.mjs', () => {
  it('archives next.md under the shipped version and opens a fresh next.md for the next one', async () => {
    const { archiveReleaseNotes } = await import(HELPER);
    const notes = '# v2.1.4\n\n- `gth eval` reads reporters from the run-level config.\n';
    const dir = tempDir({ 'next.md': notes });

    const result = archiveReleaseNotes({
      shippedVersion: '2.1.4',
      nextVersion: '2.1.5',
      notesDir: dir,
    });

    expect(result.archived).toBe(true);
    // The archive is the published text, byte for byte, H1 included.
    expect(readFileSync(join(dir, 'v2_1_4.md'), 'utf8')).toBe(notes);
    expect(readFileSync(join(dir, 'next.md'), 'utf8')).toBe('# v2.1.5\n');
    expect(result.changed).toEqual(['v2_1_4.md', 'next.md']);
  });

  it('names a prerelease archive by the existing rule', async () => {
    const { archiveReleaseNotes } = await import(HELPER);
    const dir = tempDir({ 'next.md': '# v2.0.0-beta.3\n\n- A change.\n' });
    archiveReleaseNotes({
      shippedVersion: '2.0.0-beta.3',
      nextVersion: '2.0.0-beta.4',
      notesDir: dir,
    });
    expect(existsSync(join(dir, 'v2_0_0-beta_3.md'))).toBe(true);
    expect(readFileSync(join(dir, 'next.md'), 'utf8')).toBe('# v2.0.0-beta.4\n');
  });

  it('replaces an existing archive of that name: the archive must be what was published', async () => {
    const { archiveReleaseNotes } = await import(HELPER);
    const dir = tempDir({
      'next.md': '# v2.1.4\n\n- Published.\n',
      'v2_1_4.md': '# v2.1.4\n\n- Never published.\n',
    });
    archiveReleaseNotes({ shippedVersion: '2.1.4', nextVersion: '2.1.5', notesDir: dir });
    expect(readFileSync(join(dir, 'v2_1_4.md'), 'utf8')).toBe('# v2.1.4\n\n- Published.\n');
  });

  it('archives nothing for a next.md with nothing under its heading, and still reopens it', async () => {
    const { archiveReleaseNotes } = await import(HELPER);
    // That release shipped a blank body; no file says so as well as an empty one would.
    const dir = tempDir({ 'next.md': '# v2.1.4\n\n' });
    const result = archiveReleaseNotes({
      shippedVersion: '2.1.4',
      nextVersion: '2.1.5',
      notesDir: dir,
    });
    expect(result.archived).toBe(false);
    expect(existsSync(join(dir, 'v2_1_4.md'))).toBe(false);
    expect(readFileSync(join(dir, 'next.md'), 'utf8')).toBe('# v2.1.5\n');
    expect(result.changed).toEqual(['next.md']);
  });

  it('opens next.md when there was none', async () => {
    const { archiveReleaseNotes } = await import(HELPER);
    const dir = tempDir();
    const result = archiveReleaseNotes({
      shippedVersion: '2.1.4',
      nextVersion: '2.1.5',
      notesDir: dir,
    });
    expect(result.archived).toBe(false);
    expect(readFileSync(join(dir, 'next.md'), 'utf8')).toBe('# v2.1.5\n');
  });

  it('refuses to run without both versions', async () => {
    const { archiveReleaseNotes } = await import(HELPER);
    expect(() =>
      archiveReleaseNotes({ shippedVersion: '', nextVersion: '2.1.5', notesDir: tempDir() })
    ).toThrow('both');
  });
});

describe('bump.mjs --archive-notes', () => {
  const LOCKED = ['core', 'agent', 'review', 'batch', 'app'];

  /** A scratch copy of the files bump.mjs reads and writes, sharing the repo's node_modules. */
  function scratchRepo(version: string, nextMd?: string): string {
    const root = tempDir();
    copyFileSync(join(REPO_ROOT, 'bump.mjs'), join(root, 'bump.mjs'));
    mkdirSync(join(root, 'scripts'));
    for (const name of ['release-notes-archive.mjs', 'release-notes-for.mjs']) {
      copyFileSync(join(REPO_ROOT, 'scripts', name), join(root, 'scripts', name));
    }
    for (const dir of LOCKED) {
      mkdirSync(join(root, 'packages', dir), { recursive: true });
      const name = dir === 'app' ? 'gaunt-sloth' : `@gaunt-sloth/${dir}`;
      writeFileSync(
        join(root, 'packages', dir, 'package.json'),
        JSON.stringify({ name, version, dependencies: {} }, null, 2) + '\n'
      );
    }
    mkdirSync(join(root, 'release-notes'));
    if (nextMd !== undefined) writeFileSync(join(root, 'release-notes', 'next.md'), nextMd);
    // bump.mjs imports `semver`; a junction resolves it without an install (and needs no
    // privilege on Windows, where a directory symlink would).
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
    return root;
  }

  function bump(root: string, args: string[]) {
    return spawnSync(process.execPath, [join(root, 'bump.mjs'), ...args], {
      encoding: 'utf8',
      cwd: root,
    });
  }

  function coreVersion(root: string): string {
    return JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8')).version;
  }

  it('bumps by the verb and archives under the shipped version, not the other way round', () => {
    const root = scratchRepo('2.1.4', '# v2.1.4\n\n- A change.\n');
    const run = bump(root, ['--', 'patch', '--archive-notes', '2.1.4']);

    expect(run.status, run.stderr).toBe(0);
    expect(coreVersion(root)).toBe('2.1.5');
    expect(readFileSync(join(root, 'release-notes', 'v2_1_4.md'), 'utf8')).toBe(
      '# v2.1.4\n\n- A change.\n'
    );
    expect(readFileSync(join(root, 'release-notes', 'next.md'), 'utf8')).toBe('# v2.1.5\n');
  });

  it('keeps a preid after the verb when the flag follows it', () => {
    const root = scratchRepo('2.0.0-beta.3', '# v2.0.0-beta.3\n\n- A change.\n');
    const run = bump(root, ['prerelease', 'beta', '--archive-notes', '2.0.0-beta.3']);

    expect(run.status, run.stderr).toBe(0);
    expect(coreVersion(root)).toBe('2.0.0-beta.4');
    expect(readFileSync(join(root, 'release-notes', 'next.md'), 'utf8')).toBe('# v2.0.0-beta.4\n');
  });

  it('takes an explicit next version alongside the flag', () => {
    const root = scratchRepo('2.1.4', '# v2.1.4\n\n- A change.\n');
    const run = bump(root, ['2.2.0', '--archive-notes', '2.1.4']);

    expect(run.status, run.stderr).toBe(0);
    expect(coreVersion(root)).toBe('2.2.0');
    expect(readFileSync(join(root, 'release-notes', 'next.md'), 'utf8')).toBe('# v2.2.0\n');
  });

  it('touches no notes without the flag — a plain bump is not a release', () => {
    const root = scratchRepo('2.1.4', '# v2.1.4\n\n- A change.\n');
    const run = bump(root, ['patch']);

    expect(run.status, run.stderr).toBe(0);
    expect(coreVersion(root)).toBe('2.1.5');
    expect(existsSync(join(root, 'release-notes', 'v2_1_4.md'))).toBe(false);
    expect(readFileSync(join(root, 'release-notes', 'next.md'), 'utf8')).toBe(
      '# v2.1.4\n\n- A change.\n'
    );
  });

  it('rejects the flag without a version, before writing anything', () => {
    const root = scratchRepo('2.1.4', '# v2.1.4\n\n- A change.\n');
    const run = bump(root, ['patch', '--archive-notes']);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--archive-notes');
    expect(coreVersion(root)).toBe('2.1.4');
  });
});
