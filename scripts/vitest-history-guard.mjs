/**
 * Vitest global setup — a read-only tripwire over the developer's real history store under
 * `~/.gsloth/`.
 *
 * A spec that boots a real interactive session without stubbing the history recorder or the
 * session checkpointer writes a conversation into that store on every unit run, and nothing in the
 * run says so: the suite stays green while the developer's own history fills with rows named
 * `test-model`. This fingerprints the store before the suite and fails the run in teardown, naming
 * what changed.
 *
 * The store is a directory (`~/.gsloth/history.db/` holding `index.db` and `threads/<thread>.db`),
 * and a machine that has not opened it since the split still holds the older single file at the
 * same path. Both shapes are watched, along with the names a split in progress uses beside it
 * (`history.db.pre-split`, `history.db.migrating`), because the first open of an unmigrated store
 * by unreleased code is itself a write to the developer's data. Every path under the store
 * directory is fingerprinted, so a thread file created, removed or rewritten is a change.
 *
 * It never opens a database. It reads bytes, hashes them as a stream (a store file can be larger
 * than one buffer may hold), and compares — nothing else — so it cannot itself be the writer it
 * guards against. A path that is absent at setup is fingerprinted as absent, so a spec that CREATES
 * it — the shape on a fresh machine or in CI, where nothing existed to be modified — fails the run
 * the same way. Node's own modules only, so it loads before any workspace package is built.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const storePath = join(homedir(), '.gsloth', 'history.db');

/** Paths beside the store that a split or a SQLite journal can create. */
const siblings = [
  storePath,
  `${storePath}-wal`,
  `${storePath}-journal`,
  `${storePath}.pre-split`,
  `${storePath}.pre-split-journal`,
  `${storePath}.migrating`,
];

/** The md5 of a file, read in fixed-size chunks so its size never has to fit one buffer. */
function streamedMd5(file) {
  const hash = createHash('md5');
  const chunk = Buffer.alloc(1 << 20);
  const fd = openSync(file, 'r');
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Fingerprint one path into `into`, keyed by the path: a file by its hash and size, a directory by
 * its presence and, recursively, every entry under it. An entry that cannot be read is recorded as
 * such rather than failing the run, since the point is to notice change, not to audit permissions.
 */
function fingerprintPath(path, into) {
  if (!existsSync(path)) {
    into.set(path, 'absent');
    return;
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    into.set(path, `unreadable ${error?.code ?? 'error'}`);
    return;
  }
  if (stats.isDirectory()) {
    into.set(path, 'directory');
    let entries;
    try {
      entries = readdirSync(path).sort();
    } catch (error) {
      into.set(path, `directory unreadable ${error?.code ?? 'error'}`);
      return;
    }
    for (const entry of entries) fingerprintPath(join(path, entry), into);
    return;
  }
  try {
    into.set(path, `md5 ${streamedMd5(path)} size ${stats.size}`);
  } catch (error) {
    into.set(path, `unreadable ${error?.code ?? 'error'}`);
  }
}

function fingerprint() {
  const out = new Map();
  for (const path of siblings) fingerprintPath(path, out);
  return out;
}

let before = null;

export function setup() {
  // Unconditional: 'absent' is a fingerprint too, so absent → present is a change.
  before = fingerprint();
}

export function teardown() {
  if (before === null) return;
  const after = fingerprint();
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = paths.filter((path) => before.get(path) !== after.get(path));
  if (changed.length === 0) return;
  const detail = changed.map(
    (path, i) =>
      `${i === 0 ? '' : '\n'}  ${path}\n    before: ${before.get(path) ?? 'absent'}\n` +
      `    after:  ${after.get(path) ?? 'absent'}`
  );
  // Vitest only LOGS an error thrown from a global-setup teardown ("error during close") and then
  // exits through a bare process.exit(), which honours process.exitCode — so the code is set here,
  // or the run prints the finding and still exits 0. Measured on vitest 4.1.
  process.exitCode = 1;
  throw new Error(
    `The unit run changed the developer's real history store: ${storePath}\n` +
      'A spec booted a real session without stubbing the history recorder ' +
      '(@gaunt-sloth/core/history/recordSession.js) or the session checkpointer ' +
      '(@gaunt-sloth/core/history/sessionCheckpointer.js). Stub both, the way the ' +
      'interactive-session specs do.\n' +
      detail.join('')
  );
}
