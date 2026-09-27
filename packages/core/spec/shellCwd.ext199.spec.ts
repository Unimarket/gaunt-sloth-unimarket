/**
 * EXT-199 — Core tests for shell cwd resolution, containment, and startup work directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isPathInside, resolveShellCwd } from '#src/core/shell/cwd.js';
import { getStartupWorkDir, setStartupWorkDir } from '#src/utils/systemUtils.js';

describe('EXT-199 — isPathInside', () => {
  it('returns true when target is identical to parent or inside it', () => {
    const parent = path.resolve('/tmp/project');
    expect(isPathInside(parent, parent)).toBe(true);
    expect(isPathInside(path.join(parent, 'sub'), parent)).toBe(true);
    expect(isPathInside(path.join(parent, 'sub', 'deep'), parent)).toBe(true);
  });

  it('returns false when target is outside parent or a sibling with matching prefix', () => {
    const parent = path.resolve('/tmp/project');
    expect(isPathInside(path.resolve('/tmp/project-other'), parent)).toBe(false);
    expect(isPathInside(path.resolve('/tmp/other'), parent)).toBe(false);
    expect(isPathInside(path.resolve('/tmp'), parent)).toBe(false);
    expect(isPathInside(path.resolve('/'), parent)).toBe(false);
  });
});

describe('EXT-199 — resolveShellCwd and getStartupWorkDir', () => {
  let tempBase: string;
  let projectDir: string;

  beforeEach(() => {
    tempBase = realpathSync(mkdtempSync(path.join(tmpdir(), 'ext199-core-spec-')));
    projectDir = path.join(tempBase, 'project');
    mkdirSync(projectDir, { recursive: true });
    setStartupWorkDir(projectDir);
  });

  afterEach(() => {
    setStartupWorkDir(undefined);
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('omitting cwd returns baseDir and marks inside project when baseDir is within project', () => {
    expect(getStartupWorkDir()).toBe(realpathSync(projectDir));
    const result = resolveShellCwd(undefined, projectDir);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.cwd).toBe(realpathSync(projectDir));
    expect(result.isOutsideProject).toBe(false);
    expect(result.startupWorkDir).toBe(realpathSync(projectDir));
  });

  it('relative cwd resolves against baseDir, not against process.cwd()', () => {
    const subDir = path.join(projectDir, 'sub');
    mkdirSync(subDir, { recursive: true });

    const result = resolveShellCwd('sub', projectDir);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.cwd).toBe(realpathSync(subDir));
    expect(result.isOutsideProject).toBe(false);
  });

  it('escape attempt: .. climbing out of project is detected as outside project', () => {
    const outsideDir = path.join(tempBase, 'outside');
    mkdirSync(outsideDir, { recursive: true });

    const result = resolveShellCwd('../outside', projectDir);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.cwd).toBe(realpathSync(outsideDir));
    expect(result.isOutsideProject).toBe(true);
  });

  it('escape attempt: absolute path elsewhere is detected as outside project', () => {
    const outsideDir = path.join(tempBase, 'outside');
    mkdirSync(outsideDir, { recursive: true });

    const result = resolveShellCwd(outsideDir, projectDir);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.cwd).toBe(realpathSync(outsideDir));
    expect(result.isOutsideProject).toBe(true);
  });

  it('escape attempt: symlink inside project pointing outside is detected as outside project', () => {
    const outsideDir = path.join(tempBase, 'outside');
    mkdirSync(outsideDir, { recursive: true });

    const symlinkPath = path.join(projectDir, 'link-to-outside');
    symlinkSync(outsideDir, symlinkPath, 'junction');

    const result = resolveShellCwd('link-to-outside', projectDir);
    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') return;
    expect(result.cwd).toBe(realpathSync(outsideDir));
    expect(result.isOutsideProject).toBe(true);
  });

  it('refuses nonexistent directory and runs nothing', () => {
    const result = resolveShellCwd('does-not-exist', projectDir);
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('Working directory does not exist');
  });

  it('refuses path that exists but is a regular file', () => {
    const filePath = path.join(projectDir, 'a-file.txt');
    writeFileSync(filePath, 'hello');

    const result = resolveShellCwd('a-file.txt', projectDir);
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('Working directory is not a directory');
  });

  it('refuses empty string cwd', () => {
    const result = resolveShellCwd('   ', projectDir);
    expect(result.kind).toBe('refused');
    if (result.kind !== 'refused') return;
    expect(result.message).toContain('Working directory must be a non-empty string');
  });
});
