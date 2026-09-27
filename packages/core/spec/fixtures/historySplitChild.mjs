/**
 * GS2-121 — the child-process half of `historySplitStore.spec.ts`. Each mode runs one thing in a
 * process of its own, because the properties it pins are about processes: a lock held by another
 * process, a heap cap on the process doing a split, and the vitest guard seeing another process's
 * write. It prints one JSON line on stdout and nothing else.
 *
 * It imports the BUILT package (`dist`), the same code a spec reaches through `#src`. Every path it
 * touches is given on the command line or derived from `HOME`, which the spec always points at a
 * temp directory.
 *
 * Modes:
 *   put <store> <threadId>      one checkpoint through the real saver; reports time and failures
 *   raw-write <file>            one write on a raw connection with busy_timeout 0 (the control)
 *   split <legacyFile>          split a single-file store
 *   slurp <legacyFile>          the control for `split`: read every checkpoint into the JS heap
 *   guard <split|none>          the vitest guard's setup, optionally a split of HOME's store, then
 *                               its teardown; reports whether the teardown objected
 */
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dist = (path) => new URL(`../../dist/${path}`, import.meta.url).href;
const [mode, ...args] = process.argv.slice(2);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (mode === 'put') {
  const [store, threadId] = args;
  const { openCheckpointSaver } = await import(dist('history/checkpointSaver.js'));
  const failures = [];
  const saver = openCheckpointSaver(store, { onWriteFailure: (e) => failures.push(String(e)) });
  const started = Date.now();
  await saver.put(
    { configurable: { thread_id: threadId, checkpoint_ns: '' } },
    {
      v: 4,
      id: `cp-${threadId}`,
      ts: new Date().toISOString(),
      channel_values: {},
      channel_versions: {},
      versions_seen: {},
    },
    { source: 'loop', step: 0, parents: {} },
    {}
  );
  const ms = Date.now() - started;
  saver.close();
  print({ ms, failures });
} else if (mode === 'raw-write') {
  const [file] = args;
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 0');
  try {
    db.exec(`INSERT INTO thread_meta (key, value) VALUES ('probe', 'x')`);
    print({ ok: true });
  } catch (error) {
    print({ ok: false, error: String(error?.message ?? error) });
  } finally {
    db.close();
  }
} else if (mode === 'split') {
  const [legacy] = args;
  const { splitLegacyStore } = await import(dist('history/historyMigrations.js'));
  const ok = splitLegacyStore(legacy);
  print({ ok, heapUsed: process.memoryUsage().heapUsed });
} else if (mode === 'slurp') {
  const [legacy] = args;
  const db = new DatabaseSync(legacy, { readOnly: true });
  const held = [];
  for (const row of db.prepare(`SELECT hex(checkpoint) AS h FROM checkpoints`).iterate()) {
    held.push(row.h);
  }
  print({ ok: true, rows: held.length });
} else if (mode === 'guard') {
  const [action] = args;
  const guard = await import(
    new URL('../../../../scripts/vitest-history-guard.mjs', import.meta.url).href
  );
  guard.setup();
  if (action === 'split') {
    const { splitLegacyStore } = await import(dist('history/historyMigrations.js'));
    splitLegacyStore(join(homedir(), '.gsloth', 'history.db'));
  }
  try {
    guard.teardown();
    print({ objected: false });
  } catch (error) {
    print({ objected: true, message: String(error?.message ?? error).split('\n')[0] });
  }
  process.exitCode = 0;
} else {
  print({ error: `unknown mode ${mode}` });
  process.exitCode = 2;
}
