import { Command } from 'commander';
import type { CommandLineConfigOverrides } from '@gaunt-sloth/core/config.js';
import { openHistoryStore } from '@gaunt-sloth/core/history/historyStore.js';
import {
  formatCheckpointStoreStats,
  formatInsightsSummary,
} from '@gaunt-sloth/core/history/historyFormat.js';
import { openCheckpointMaintenance } from '@gaunt-sloth/core/history/checkpointRetention.js';
import { display, displayInfo, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { resolveHistoryCommandStore } from '#src/commands/historyCommand.js';

/**
 * GS2-7 (B20) — `gth insights`: lightweight, LOCAL analytics over the session store (token/cost
 * totals, a top-tool tally, and a per-command breakdown). Read-only and fail-soft: opens with
 * `create: false`, so a missing DB just prints "no history yet" rather than creating one. Nothing
 * leaves the machine. The store is `--db <path>`, then `history.dbPath` from the config, then the
 * default `~/.gsloth/history.db` — the precedence every history command shares (GS2-119).
 */
export function insightsCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides = {}
): void {
  program
    .command('insights')
    .description('Show local analytics over recorded session history (local only)')
    .option(
      '--db <path>',
      'path to the history store (defaults to `history.dbPath` from your config, then ' +
        '~/.gsloth/history.db)'
    )
    .addHelpText(
      'after',
      '\n' + 'Examples:\n' + '  $ gth insights\n' + '  $ gth insights --db ./project-history.db\n'
    )
    .action(async (options: { db?: string }) => {
      const dbPath = await resolveHistoryCommandStore(options.db, commandLineConfigOverrides);
      const store = openHistoryStore(dbPath, { create: false });
      if (!store) {
        displayWarning(
          'No session history found. Recording is on by default; `history.enabled: false` in your ' +
            'config turns it off.'
        );
        return;
      }
      try {
        const insights = store.insights();
        displayInfo('Session insights (local only):');
        for (const line of formatInsightsSummary(insights)) display(line);
      } finally {
        store.close();
      }
      // GS2-107 — the volume of the conversation store, reported where a person already comes for
      // numbers about their own usage. A checkpoint is not a transcript: it carries tool results,
      // file contents and command output verbatim, so the store grows far faster than the session
      // count suggests, and nothing made that visible before.
      const maintenance = openCheckpointMaintenance(dbPath);
      if (!maintenance) return;
      try {
        displayInfo('Conversation store (local only):');
        for (const line of formatCheckpointStoreStats(maintenance.stats())) display(line);
      } finally {
        maintenance.close();
      }
    });
}
