// OPS-59 — after a release ships, archive release-notes/next.md as that version's notes file and
// open a fresh next.md for the version now in development.
//
// The notes for the release in development accumulate in next.md, a bullet per user-facing change,
// written before each change merges; the release publishes that file (release-notes-for.mjs). This
// runs in the post-bump — bump.mjs `--archive-notes <shipped version>` — so the archive, the fresh
// file and the version bump land in ONE commit on main.
//
// WHY THE ARCHIVE IS THE PUBLISHED TEXT, AND NOT A WIPE. The post-bump checks out the same main the
// release shipped, so next.md here is the file the Release body was made from. Renaming it keeps
// the record of what each version said; deleting it would make the release page the only copy. A
// bullet merged while a release is running would be swept into the shipped version's file — which
// is why gaunt-sloth does not merge while a release runs, and is not something this can detect.
//
// WHAT IS ARCHIVED. The whole file, H1 included, under `v` + the version with every dot replaced by
// an underscore + `.md` — the name every earlier release's notes already carry. An existing file of
// that name is replaced: the archive must be what was published, and next.md is the only source a
// release reads. A next.md with nothing under its heading is not archived, because that release
// shipped a blank body and no file says so as well as a file with nothing in it.
//
// THE FRESH FILE opens with `# v<next version>` and nothing else. The heading becomes the Release
// title; keep it, or replace it with a descriptive one for a release that earns it.
//
// NO dependencies beyond node: builtins — bump.mjs imports this at the repo root, after the publish,
// where a failed import would leave main un-bumped.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_NOTES_DIR,
  NEXT_NOTES_FILE,
  notesFileName,
  splitTitleAndBody,
} from './release-notes-for.mjs';

/**
 * The content of a fresh next.md for the version now in development.
 * @param {string} nextVersion
 * @returns {string}
 */
export function freshNextNotes(nextVersion) {
  return `# v${nextVersion}\n`;
}

/**
 * Archive next.md as the shipped version's notes and open a fresh next.md.
 *
 * @param {{ shippedVersion: string, nextVersion: string, notesDir?: string }} options
 * @returns {{ nextPath: string, archivePath: string, archived: boolean, changed: string[] }}
 *   `changed` lists every file written, relative to `notesDir`, for the caller to commit.
 */
export function archiveReleaseNotes({ shippedVersion, nextVersion, notesDir = DEFAULT_NOTES_DIR }) {
  if (!shippedVersion || !nextVersion) {
    throw new Error('archiveReleaseNotes needs both the shipped and the next version');
  }
  const nextPath = join(notesDir, NEXT_NOTES_FILE);
  const archiveName = notesFileName(shippedVersion);
  const archivePath = join(notesDir, archiveName);
  /** @type {string[]} */
  const changed = [];

  let archived = false;
  if (existsSync(nextPath)) {
    const text = readFileSync(nextPath, 'utf8');
    if (splitTitleAndBody(text, shippedVersion).body.trim() !== '') {
      writeFileSync(archivePath, text, 'utf8');
      changed.push(archiveName);
      archived = true;
    }
  }
  writeFileSync(nextPath, freshNextNotes(nextVersion), 'utf8');
  changed.push(NEXT_NOTES_FILE);
  return { nextPath, archivePath, archived, changed };
}
