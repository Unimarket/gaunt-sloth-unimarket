/**
 * GS2-119 — the child-process half of `historyCommandStorePath.spec.ts`. It resolves the store a
 * read-only history command opens, in a process whose `HOME` and working directory the spec chose,
 * so the global config layer and the project discovery walk are the real ones and neither can see
 * the developer's own `~/.gsloth/`.
 *
 * Usage: node historyStorePathChild.mjs <db-flag-or-dash>
 * Prints one JSON line: the resolved store path, and whether anything exists there afterwards.
 */
import { existsSync } from 'node:fs';

const [dbArg] = process.argv.slice(2);
const { resolveHistoryCommandStore } = await import(
  new URL('../../dist/commands/historyCommand.js', import.meta.url).href
);
const store = await resolveHistoryCommandStore(dbArg === '-' ? undefined : dbArg, {});
process.stdout.write(`${JSON.stringify({ store, exists: existsSync(store) })}\n`);
