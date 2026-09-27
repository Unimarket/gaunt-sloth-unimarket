import { Command } from 'commander';
import {
  initConfig,
  loadConfiguredHistoryDbPath,
  type CommandLineConfigOverrides,
} from '@gaunt-sloth/core/config.js';
import {
  openHistoryStore,
  rebuildHistoryIndexSafe,
  resolveHistoryDbPath,
} from '@gaunt-sloth/core/history/historyStore.js';
import { isHistoryEnabled } from '@gaunt-sloth/core/history/historyEnabled.js';
import {
  lookupConversationSafe,
  resolveConversationRefSafe,
} from '@gaunt-sloth/core/history/recordSession.js';
import {
  formatConversationRef,
  parseConversationRef,
} from '@gaunt-sloth/core/history/conversationRef.js';
import {
  formatConversationList,
  formatConversationThread,
  formatPrunePlan,
  formatPruneResult,
  formatSearchResults,
  formatStoreSizeLine,
} from '@gaunt-sloth/core/history/historyFormat.js';
import {
  openCheckpointMaintenance,
  type PruneBounds,
} from '@gaunt-sloth/core/history/checkpointRetention.js';
import {
  display,
  displayInfo,
  displayNotice,
  displaySuccess,
  displayWarning,
} from '@gaunt-sloth/core/utils/consoleUtils.js';
import { getStringFromStdin, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { resumeMatrixVerdict } from '@gaunt-sloth/core/history/resumeMatrix.js';

/**
 * The one sentence for "there is no store": `list`, `search`, `show` and `resume` all say it, so a
 * person with nothing recorded yet hears the same thing whichever they typed — and is not told a
 * conversation id is unknown when the file it would be in does not exist.
 */
export const NO_HISTORY_MESSAGE =
  'No session history found. Recording is on by default; `history.enabled: false` in your ' +
  'config turns it off.';
import { startSession } from '#src/modules/startSession.js';
import { sessionConfigFor } from '#src/modules/sessionConfigs.js';

/** The `--db` help text every read-only history command shares. */
const DB_OPTION_HELP =
  'path to the history store (defaults to `history.dbPath` from your config, then ' +
  '~/.gsloth/history.db)';

/**
 * GS2-119 — the store a read-only history command opens: `--db`, then `history.dbPath` from the
 * config these overrides select, then the default. The same precedence as every recorder, which is
 * what makes `history list` show the store a run wrote. Exported for `gth insights`.
 */
export async function resolveHistoryCommandStore(
  db: string | undefined,
  commandLineConfigOverrides: CommandLineConfigOverrides
): Promise<string> {
  if (db !== undefined && db.trim().length > 0) return resolveHistoryDbPath(db);
  return resolveHistoryDbPath(await loadConfiguredHistoryDbPath(commandLineConfigOverrides));
}

/**
 * GS2-7 (B20) / GS2-19 — the `gth history` command group over the local session store.
 *
 * - `gth history search <query...>` — FTS5 full-text search across past turns; each hit shows the
 *   parent conversation it belongs to (GS2-19).
 * - `gth history list` — the most recent conversations (grouped, with turn count + timespan), the
 *   top-level unit since GS2-19 (was a flat per-turn list).
 * - `gth history show <id>` — print a whole conversation thread, all turns in order (GS2-19).
 * - `gth history resume <id> [message]` — GS2-20: continue a recorded conversation as the command
 *   it was recorded under: an interactive session for `chat` / `code`, and (GS2-106) one more `ask`
 *   or `exec` run, with the new message, for a single-shot one.
 *
 * The first three are READ-ONLY and fail-soft: they open the store with `create: false`, so a
 * missing store (nothing recorded yet, or history turned off) simply reports "no history yet"
 * instead of materialising an empty one. (Opening still migrates the store: a single-file store
 * from an earlier release is split on first open — see `historyLayout.ts` in core.) The store is
 * `--db <path>`, then `history.dbPath` from the config, then the global `~/.gsloth/history.db`
 * (GS2-119). `history.enabled: false` does not stop them reading a store that exists: the switch
 * governs recording. Local only — nothing here touches the network.
 *
 * `resume` is the exception on both counts: it starts a session, so it loads the whole config the
 * session will run under (which is also where `history.dbPath` and `history.enabled` come from —
 * hence no `--db`: a resumed session must read the store the session itself records to) and takes
 * the same command-line overrides the session commands take.
 */
export function historyCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides = {}
): void {
  const history = program
    .command('history')
    .description('Search and list locally-recorded session history (local only)')
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth history list\n' +
        '  $ gth history search vertexai timeout\n' +
        '  $ gth history show 42\n' +
        '  $ gth history resume 42\n' +
        '  $ gth history resume 43 "and now the tests"\n' +
        '  $ gth history rebuild\n'
    );

  history
    .command('search')
    .description('Full-text search past sessions (SQLite FTS5)')
    .argument('<query...>', 'search terms')
    .option('--db <path>', DB_OPTION_HELP)
    .option('--limit <n>', 'maximum results', '20')
    .action(async (queryParts: string[], options: { db?: string; limit?: string }) => {
      const storePath = await resolveHistoryCommandStore(options.db, commandLineConfigOverrides);
      const store = openHistoryStore(storePath, { create: false });
      if (!store) {
        displayWarning(NO_HISTORY_MESSAGE);
        return;
      }
      try {
        const limit = clampLimit(options.limit);
        const results = store.search(queryParts.join(' '), limit);
        displayInfo(`History search: "${queryParts.join(' ')}"`);
        for (const line of formatSearchResults(results)) display(line);
      } finally {
        store.close();
      }
    });

  history
    .command('list')
    .description('List the most recent recorded conversations')
    .option('--db <path>', DB_OPTION_HELP)
    .option('--limit <n>', 'maximum results', '20')
    .action(async (options: { db?: string; limit?: string }) => {
      const dbPath = await resolveHistoryCommandStore(options.db, commandLineConfigOverrides);
      const store = openHistoryStore(dbPath, { create: false });
      if (!store) {
        displayWarning(NO_HISTORY_MESSAGE);
        return;
      }
      try {
        const limit = clampLimit(options.limit);
        const conversations = store.listConversations(limit);
        displayInfo('Recent conversations:');
        // GS2-106 — with the run id beside each integer, so a person can copy the id that stays
        // correct after the database is recreated. Only here: the in-session lists keep the short
        // form, where the integer is what `/resume` is typed with.
        for (const line of formatConversationList(conversations, { showRunId: true })) {
          display(line);
        }
      } finally {
        store.close();
      }
      // GS2-107 — the size readout goes HERE, under the listing, because this is the screen a
      // person is already on when they wonder what the store holds. One line: the volume, where
      // the breakdown is, and what reclaims it.
      const maintenance = openCheckpointMaintenance(dbPath);
      if (!maintenance) return;
      try {
        const stats = maintenance.stats();
        // GS2-111 — checkpoints are not the whole store. A dropped `put` leaves a thread holding
        // pending writes and no checkpoint: real bytes on disk that only `gth history prune` takes
        // back. A guard on the checkpoint count alone made the one screen that reports the store's
        // size silent about them (DL-1), so this is the pair GS2-108 settled on for `gth insights`.
        if (stats.checkpointCount > 0 || stats.writeOnlyThreadCount > 0) {
          display(formatStoreSizeLine(stats));
        }
      } finally {
        maintenance.close();
      }
    });

  history
    .command('show')
    .description('Print a whole conversation thread (all turns in order)')
    .argument('<id>', 'conversation id or run id (from `history list` / `history search`)')
    .option('--db <path>', DB_OPTION_HELP)
    .action(async (idArg: string, options: { db?: string }) => {
      // GS2-106 — the shared parser, so `12abc` is refused rather than read as 12, and a run id is
      // accepted here exactly as `history resume` accepts it.
      const ref = parseConversationRef(idArg);
      if (ref === null) {
        displayWarning(`Invalid conversation id "${idArg}".`);
        return;
      }
      const storePath = await resolveHistoryCommandStore(options.db, commandLineConfigOverrides);
      const store = openHistoryStore(storePath, { create: false });
      if (!store) {
        displayWarning(NO_HISTORY_MESSAGE);
        return;
      }
      try {
        const id = store.resolveConversationRef(ref);
        if (id === null) {
          displayWarning(
            `No conversation ${formatConversationRef(ref)} in the history store. Run ` +
              '`gth history list` to see the ids.'
          );
          return;
        }
        const turns = store.getConversationThread(id);
        displayInfo(`Conversation #${id}:`);
        for (const line of formatConversationThread(turns)) display(line);
      } finally {
        store.close();
      }
    });

  // GS2-107 — the half of the retention policy that can cost a resume, and therefore the half a
  // person has to type. Automatic reclamation removes only threads no conversation names; this
  // removes stored state someone could still have resumed, so:
  //
  // - it takes an explicit bound and refuses to guess one. A default here would be an age-based
  //   retention policy applied to everybody without being asked, which is exactly what the ruling
  //   GS2-20 was built to ("resume sheds nothing") forbids;
  // - it prints the plan and removes nothing until `--yes`. The dry run is the default because the
  //   second layer of it matters more than the keystroke: an invocation that forgets `--db` resolves
  //   to the configured store or the developer's own `~/.gsloth/history.db`;
  // - it prunes WHOLE conversations. A count bound here means "keep the N most recent
  //   conversations", never "keep the last N super-steps of a thread" — a checkpoint chain is not
  //   safe to truncate in the middle as a policy, whatever one graph's channel schema allows today.
  history
    .command('prune')
    .description('Remove stored conversation state (transcripts stay) and reclaim the file')
    .option('--older-than <days>', 'prune conversations with no activity for this many days')
    .option('--keep-last <n>', 'keep the N most recently active conversations, prune the rest')
    .option('--yes', 'actually remove; without it this prints the plan and changes nothing')
    .option('--db <path>', DB_OPTION_HELP)
    .addHelpText(
      'after',
      '\n' +
        'A pruned conversation keeps its transcript — `gth history show <id>` still prints it —\n' +
        'and loses only the state a resume needs. Threads no conversation names are reclaimed\n' +
        'automatically a day after the session ends; this is for the rest.\n' +
        '\n' +
        'This removes exactly what your bounds select, including a conversation that is open in\n' +
        'another window right now — the plan marks those `<- active today`.\n' +
        '\n' +
        'Examples:\n' +
        '  $ gth history prune --older-than 30\n' +
        '  $ gth history prune --keep-last 20 --yes\n'
    )
    .action(
      async (options: { olderThan?: string; keepLast?: string; yes?: boolean; db?: string }) => {
        const olderThanDays = parseBound(options.olderThan, 'older-than');
        const keepLast = parseBound(options.keepLast, 'keep-last');
        if (olderThanDays === 'invalid' || keepLast === 'invalid') return;
        if (olderThanDays === undefined && keepLast === undefined) {
          displayWarning(
            'Nothing was removed: `gth history prune` needs a bound. Use `--older-than <days>`, ' +
              '`--keep-last <n>`, or both — this command can make a conversation unresumable, so it ' +
              'never picks one for you.'
          );
          return;
        }
        const dbPath = await resolveHistoryCommandStore(options.db, commandLineConfigOverrides);
        const maintenance = openCheckpointMaintenance(dbPath);
        if (!maintenance) {
          displayWarning(NO_HISTORY_MESSAGE);
          return;
        }
        try {
          const bounds: PruneBounds = { olderThanDays, keepLast };
          const candidates = maintenance.prunable(bounds);
          // The automatic set rides along: it is free, it cannot cost a resume, and reporting it here
          // is how a person finds out how much of the store was never reachable in the first place.
          const unaddressable = maintenance.unaddressable();
          const unaddressableBytes = maintenance.bytesOf(unaddressable);
          // GS2-108 — and so does the write-only set: threads whose pending writes outlived the
          // checkpoint they belonged to. This is the ONLY command that reaches them, because they
          // carry no checkpoint to read an age from and the automatic pass reclaims nothing it
          // cannot date. The reasoning is at `findWriteOnlyThreads`.
          const writeOnly = maintenance.writeOnly();
          const writeOnlyBytes = maintenance.bytesOf(writeOnly);
          displayInfo('History prune:');
          for (const line of formatPrunePlan(
            candidates,
            unaddressable.length,
            unaddressableBytes,
            writeOnly.length,
            writeOnlyBytes
          )) {
            display(line);
          }
          if (candidates.length === 0 && unaddressable.length === 0 && writeOnly.length === 0)
            return;
          if (!options.yes) {
            displayWarning('Nothing was removed. Re-run with `--yes` to remove it.');
            return;
          }
          const before = maintenance.diskBytes();
          // GS2-121 — each thread's state is its own file: removing it deletes the file, or strips
          // and compacts a conversation's home file, so the space comes back thread by thread.
          const removed = maintenance.remove([
            ...candidates.map((c) => c.threadId),
            ...unaddressable,
            ...writeOnly,
          ]);
          const after = maintenance.diskBytes();
          for (const line of formatPruneResult(removed, before, after, true)) display(line);
          displaySuccess('History prune complete.');
        } finally {
          maintenance.close();
        }
      }
    );

  // GS2-121 — the index is a cache of the thread files, and this rebuilds it from them alone: what
  // a person runs when `index.db` is damaged or was deleted, or when thread files were copied in
  // from elsewhere. A missing index is rebuilt on its own at the next open; this also replaces one
  // that is there. Conversations keep their ids.
  history
    .command('rebuild')
    .description('Rebuild the history index from the per-conversation files')
    .option('--db <path>', DB_OPTION_HELP)
    .addHelpText(
      'after',
      '\n' +
        'Run it with no session open: a session that writes during the rebuild writes to the\n' +
        'index being replaced.\n'
    )
    .action(async (options: { db?: string }) => {
      const storePath = await resolveHistoryCommandStore(options.db, commandLineConfigOverrides);
      const summary = rebuildHistoryIndexSafe(storePath);
      if (!summary) {
        displayWarning(NO_HISTORY_MESSAGE);
        setExitCode(1);
        return;
      }
      display(
        `Rebuilt the index from ${summary.threadFiles} thread ` +
          `${summary.threadFiles === 1 ? 'file' : 'files'}: ${summary.conversations} ` +
          `${summary.conversations === 1 ? 'conversation' : 'conversations'}, ${summary.turns} ` +
          `${summary.turns === 1 ? 'turn' : 'turns'}.`
      );
      if (summary.unreadable > 0) {
        displayWarning(
          `${summary.unreadable} ${summary.unreadable === 1 ? 'file' : 'files'} in the store ` +
            'could not be read and were left as they are.'
        );
      }
      displaySuccess('History rebuild complete.');
    });

  // GS2-20 — the third spelling of a resume. The mode comes from the ROW, not from the person: a
  // conversation recorded by `gth chat` resumes as a chat session, one recorded by `gth code` as a
  // code session, and (GS2-106) one recorded by `gth ask` or `gth exec` runs as that command again
  // with the new message. This spelling never switches command; `gth <command> --resume` is the one
  // that does. Everything past picking the command is that command's own path with its resume, so
  // the checks and their sentences are the seam's, made once. What is decided HERE is only what has
  // to be decided before a command can start: is there such a row, and does the matrix let it be
  // resumed at all.
  //
  // Every refusal here exits 1 (GS2-106): the person asked for something to run and it did not.
  history
    .command('resume')
    .description(
      'Pick up a recorded conversation where it left off, as the command it was recorded under'
    )
    .argument('<id>', 'conversation id or run id (from `history list`)')
    .argument(
      '[message]',
      'the new message: required for an ask or exec conversation (or pipe it on stdin), ' +
        'optional for chat or code'
    )
    .action(async (idArg: string, message: string | undefined) => {
      const refuse = (sentence: string): void => {
        displayWarning(sentence);
        setExitCode(1);
      };
      const ref = parseConversationRef(idArg);
      if (ref === null) {
        refuse(`Invalid conversation id "${idArg}".`);
        return;
      }
      const config = await initConfig(commandLineConfigOverrides);
      if (!isHistoryEnabled(config)) {
        refuse(
          'History is off: `history.enabled: false` in your config turns recording off, and only ' +
            'a recorded conversation can be resumed.'
        );
        return;
      }
      // No store at all is "no history yet", the same answer `history list` gives in that state —
      // not an unknown id, which would send the person looking for a typo in a number.
      const store = openHistoryStore(resolveHistoryDbPath(config.history?.dbPath), {
        create: false,
      });
      if (!store) {
        refuse(NO_HISTORY_MESSAGE);
        return;
      }
      store.close();
      // GS2-106 — resolved to the integer HERE, through the same exact-match lookup the resume seam
      // uses, because the row's command has to be read before a command can be started for it.
      const id = resolveConversationRefSafe(config, ref);
      const stored = id === null ? null : lookupConversationSafe(config, id);
      if (id === null || !stored) {
        refuse(
          `No conversation ${formatConversationRef(ref)} in the history store. Run ` +
            '`gth history list` to see the ids.'
        );
        return;
      }
      // GS2-106 — the matrix is asked BEFORE the message is demanded, so a fan-out cell or a
      // `review` row is refused for what it is rather than for a missing message. The sentence is
      // the seam's own, so this refusal reads exactly as `ask --resume` would say it.
      const verdict = resumeMatrixVerdict(stored.summary, 'history');
      if (!verdict.ok) {
        const { resumeRefusalNotice } = await import('@gaunt-sloth/agent/modules/sessionResume.js');
        const notice = resumeRefusalNotice({
          kind: 'not-resumable',
          id,
          reason: verdict.reason,
          command: stored.summary.command,
          ...(verdict.reason === 'fan-out' ? { origin: verdict.origin } : {}),
        });
        displayNotice(notice.title, [...notice.lines, 'Nothing was run.'], { tone: 'warn' });
        setExitCode(1);
        return;
      }
      const command = stored.summary.command;
      if (command === 'ask' || command === 'exec') {
        // A single-shot conversation needs something new to say: from the positional, or from
        // stdin the way `ask` reads a pipe. It is the whole new user message either way.
        const text = message ?? getStringFromStdin();
        if (!text) {
          refuse(
            `Conversation #${id} was recorded by \`gth ${command}\`, so resuming it needs a new ` +
              `message: \`gth history resume ${id} "…"\`, or pipe one on stdin. Nothing was run.`
          );
          return;
        }
        if (command === 'ask') {
          const { runAskCommand } = await import('#src/commands/askCommand.js');
          await runAskCommand(text, {}, commandLineConfigOverrides, {
            ref: id,
            surface: 'history',
          });
        } else {
          const { runExecCommand } = await import('#src/commands/execCommand.js');
          await runExecCommand(undefined, { message: text }, commandLineConfigOverrides, {
            ref: id,
            surface: 'history',
          });
        }
        return;
      }
      // chat / code: the matrix allowed it, so there is a session config for it. The message, if
      // any, is the session's first input, which both session commands already accept.
      const sessionConfig = sessionConfigFor(command)!;
      await startSession(sessionConfig, commandLineConfigOverrides, message, {
        resumeConversationId: id,
      });
    });
}

/**
 * GS2-107 — parse a prune bound. `undefined` when the flag was not given, `'invalid'` (having said
 * so) when it was given as something that is not a positive whole number.
 *
 * A bad bound is refused rather than clamped, unlike `--limit` below: clamping a listing to 20 rows
 * costs a reader nothing, and quietly reinterpreting the bound on a command that deletes state would
 * remove a different set from the one the person asked for.
 */
function parseBound(raw: string | undefined, flag: string): number | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  // `Number('')` and `Number('  ')` are both 0, not NaN, so an empty flag value has to be refused
  // before the numeric test rather than by it. And zero itself is refused: `--older-than 0` means
  // "older than right now", which selects every conversation that has stored state — the widest
  // possible delete, reached by typing the narrowest-looking bound.
  const n = raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    displayWarning(
      `Nothing was removed: \`--${flag} ${raw}\` is not a positive whole number of ` +
        `${flag === 'older-than' ? 'days' : 'conversations'}.`
    );
    return 'invalid';
  }
  return n;
}

/** Parse and bound a `--limit` option (1..500); falls back to 20 on a bad value. */
function clampLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 500);
}
