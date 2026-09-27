/**
 * EXT-199 — Working directory resolution, containment, and out-of-project boundary checks
 * for shell commands.
 *
 * ## Out-of-Project Security Boundary (Ruling, Andrew, 2026-09-27)
 * "The project" is defined strictly as the session's startup work directory, captured once
 * and realpath-resolved ({@link getStartupWorkDir}). It is never a moved or dynamic value.
 *
 * An execution directory is considered OUTSIDE the project if its canonical (realpath)
 * location is not contained within the canonical startup work directory.
 * All escape vectors count as outside the project:
 *  - Traversal with `..` that climbs out of the project root
 *  - Absolute paths targeting locations elsewhere on the filesystem
 *  - Symlinks located within the project tree whose targets resolve outside it
 *
 * Rung behaviour for out-of-project commands:
 *  - `manual`, `write`, `assisted`: ALWAYS requires an explicit confirmation dialog from the
 *    human, even when an allow rule or standing grant would otherwise approve the command.
 *  - `auto`: ALWAYS requires the same confirmation dialog (rater-based auto-handling is EXT-200).
 *  - `bypass`: runs without prompting.
 *
 * Inside the project, commands follow the normal flow for their rung.
 *
 * ## Grant Rule Inside the Project
 * A grant or allow-rule keyed on a command string (e.g. `pnpm test`) applies in EVERY subdirectory
 * of the project. When `cwd` is within the project root, a standing grant for `pnpm test`
 * approves `pnpm test` with `cwd: packages/app` without prompting.
 * However, that same grant will NOT auto-approve the command when `cwd` points outside the project;
 * the out-of-project prompt requirement outranks standing grants across all non-bypass rungs.
 *
 * @module
 */

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { getCurrentWorkDir, getStartupWorkDir } from '#src/utils/systemUtils.js';

/**
 * Checks whether `target` is within `parent` (or identical to it), accounting for
 * directory boundaries and platform path resolution.
 */
export function isPathInside(target: string, parent: string): boolean {
  const normTarget = path.resolve(target);
  const normParent = path.resolve(parent);
  const rel = path.relative(normParent, normTarget);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return true;
  }
  // On Windows, drive letters or case might differ between realpath and resolve
  if (process.platform === 'win32') {
    const relLower = path.relative(normParent.toLowerCase(), normTarget.toLowerCase());
    return relLower === '' || (!relLower.startsWith('..') && !path.isAbsolute(relLower));
  }
  return false;
}

export type ShellCwdResult =
  | {
      kind: 'resolved';
      cwd: string;
      isOutsideProject: boolean;
      startupWorkDir: string;
    }
  | {
      kind: 'refused';
      message: string;
    };

/**
 * Resolves and validates a working directory for shell command execution.
 *
 * @param requestedCwd The requested working directory argument from the tool call.
 * @param baseDir The base directory to resolve relative paths against. Defaults to
 *                `getCurrentWorkDir()`, and in the agent, `getShellWorkDir()`.
 *                Never resolves against `process.cwd()`.
 */
export function resolveShellCwd(
  requestedCwd?: string,
  baseDir: string = getCurrentWorkDir()
): ShellCwdResult {
  const startupWorkDir = getStartupWorkDir();

  // Omitting cwd: runs in baseDir, preserving existing behaviour exactly.
  if (requestedCwd === undefined) {
    const resolvedBase = path.resolve(baseDir);
    let realBase: string;
    try {
      realBase = realpathSync(resolvedBase);
    } catch {
      realBase = resolvedBase;
    }
    return {
      kind: 'resolved',
      cwd: realBase,
      isOutsideProject: !isPathInside(realBase, startupWorkDir),
      startupWorkDir,
    };
  }

  // Refusal: cwd was passed but is empty or not a string
  if (typeof requestedCwd !== 'string' || requestedCwd.trim() === '') {
    return {
      kind: 'refused',
      message: 'Working directory must be a non-empty string.',
    };
  }

  // Relative paths resolve against baseDir (getShellWorkDir()), never against process.cwd()
  const resolved = path.isAbsolute(requestedCwd)
    ? path.resolve(requestedCwd)
    : path.resolve(baseDir, requestedCwd);

  // Path is realpath-resolved so symlinks cannot disguise where the command really runs
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    // Refusal: nonexistent directory or broken symlink
    if (code === 'ENOENT') {
      return {
        kind: 'refused',
        message: `Working directory does not exist: ${resolved}`,
      };
    }
    return {
      kind: 'refused',
      message: `Cannot resolve working directory: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  // Refusal: target exists but is not a directory (e.g. regular file)
  try {
    const stat = statSync(real);
    if (!stat.isDirectory()) {
      return {
        kind: 'refused',
        message: `Working directory is not a directory: ${resolved}`,
      };
    }
  } catch (err: unknown) {
    return {
      kind: 'refused',
      message: `Cannot access working directory: ${(err as Error)?.message ?? String(err)}`,
    };
  }

  // Escape attempts (.. traversal, absolute path elsewhere, symlink target outside)
  // are detected here against the captured startup work directory.
  const isOutsideProject = !isPathInside(real, startupWorkDir);

  return {
    kind: 'resolved',
    cwd: real,
    isOutsideProject,
    startupWorkDir,
  };
}
