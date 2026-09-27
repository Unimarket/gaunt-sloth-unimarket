import { Command } from 'commander';
import { CommandLineConfigOverrides, initConfig } from '@gaunt-sloth/core/config.js';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { getAskSystemPrompt } from '#src/commands/commandIntrospection.js';
import { getStringFromStdin, setExitCode } from '@gaunt-sloth/core/utils/systemUtils.js';
import { displayError, displayWarning } from '@gaunt-sloth/core/utils/consoleUtils.js';
import { wrapContent } from '@gaunt-sloth/core/utils/llmUtils.js';

import { readMultipleFilesFromProjectDir } from '@gaunt-sloth/core/utils/fileUtils.js';
import type { ConversationRef } from '@gaunt-sloth/core/history/conversationRef.js';
import type { SingleShotResume } from '@gaunt-sloth/core/runtime/singleShot.js';
import { resumeOption } from '#src/commands/resumeOption.js';

export interface AskCommandOptions {
  file?: string[];
  /**
   * Opt `ask` into "do-the-job" mode: enable the same full filesystem + dev tools that
   * `exec`/`code` get, so the question can act (read/write files, run commands) rather than
   * just chat. Off by default; loud when active because it grants write access.
   */
  write?: boolean;
}

/**
 * When `ask --write` is set, upgrade the effective config so the `ask` run gets the same
 * "do-the-job" capabilities as `exec`/`code`: full (`all`) filesystem access plus dev tools.
 *
 * Filesystem mode is overridden on the per-command `commands.ask` slice (where
 * `getEffectiveConfig` reads it from), and `askWriteMode` is set so the agent's tool resolution
 * enables dev tools for `ask`. CFG-18: the dev/shell tools live in the unified `builtInTools`
 * registry, so `ask --write` reuses exec's (falling back to code's) `builtInTools` config — copied
 * onto `commands.ask.builtInTools` — rather than a separate `devTools` key. Returns the config
 * untouched when `--write` is not set.
 *
 * Exported for unit testing.
 */
export function applyAskWriteMode(config: GthConfig, options: AskCommandOptions): GthConfig {
  if (!options.write) {
    return config;
  }
  displayWarning(
    'ask --write: filesystem and dev tools enabled — this run can read/write files and run commands.'
  );
  const askBuiltInTools =
    config.commands?.exec?.builtInTools ?? config.commands?.code?.builtInTools;
  return {
    ...config,
    askWriteMode: true,
    commands: {
      ...config.commands,
      ask: {
        ...config.commands?.ask,
        filesystem: 'all',
        ...(askBuiltInTools ? { builtInTools: askBuiltInTools } : {}),
      },
    },
  };
}

/**
 * Adds the ask command to the program
 * @param program - The commander program
 * @param commandLineConfigOverrides - command line config overrides
 */
export function askCommand(
  program: Command,
  commandLineConfigOverrides: CommandLineConfigOverrides
): void {
  program
    .command('ask')
    .description('Ask a question')
    .argument('[message]', 'A message')
    .option(
      '-f, --file [files...]',
      'Input files. Content of these files will be added BEFORE the message'
    )
    .option(
      '--write',
      'Let ask act, not just chat: enable full filesystem + dev tools (like exec/code) so it can ' +
        'read/write files and run commands. Grants write access — use with care.'
    )
    .addOption(resumeOption())
    .addHelpText(
      'after',
      '\n' +
        'Examples:\n' +
        '  $ gth ask "which types of primitives are available in JavaScript?"\n' +
        '  $ gth ask "Please explain this code" -f index.js\n' +
        '  $ cat error.log | gth ask "What might be causing these errors?"\n' +
        '  $ gth ask --resume <run id> "and what about the second one?"\n'
    )
    .action(async (message: string, options: AskCommandOptions & { resume?: ConversationRef }) => {
      // GS2-106 — `--resume` on `ask` itself, or the root `gth --resume <id> ask …`: the same
      // reading `sessionOptionsFor` makes for `chat`/`code`, since commander may hand the flag to
      // either.
      const ref =
        options.resume ?? (program.getOptionValue('resume') as ConversationRef | undefined);
      await runAskCommand(
        message,
        options,
        commandLineConfigOverrides,
        ref === undefined ? undefined : { ref, surface: 'ask' }
      );
    });
}

/**
 * The body of `gth ask`, shared with `gth history resume` for a conversation recorded by `ask`
 * (GS2-106), so both spellings run exactly one implementation.
 *
 * `resume`, when given, continues that conversation: the seam resolves and checks it first, and a
 * refusal ends the command with exit status 1 and nothing run. From `history resume` the message is
 * the whole input — that command has already read it, from its positional or from stdin — so stdin
 * is not read a second time here.
 */
export async function runAskCommand(
  message: string | undefined,
  options: AskCommandOptions,
  commandLineConfigOverrides: CommandLineConfigOverrides,
  resume?: { ref: ConversationRef | number; surface: 'ask' | 'history' }
): Promise<void> {
  const config = applyAskWriteMode(await initConfig(commandLineConfigOverrides), options);
  const content = [];
  if (options.file) {
    content.push(readMultipleFilesFromProjectDir(options.file));
  }
  const stringFromStdin = resume?.surface === 'history' ? '' : getStringFromStdin();
  if (stringFromStdin) {
    content.push(wrapContent(stringFromStdin, 'stdin-content'));
  }
  if (message) {
    content.push(wrapContent(message, 'message', 'user message'));
  }

  // Validate that at least one input source is provided
  if (content.length === 0) {
    throw new Error('At least one of the following is required: file, stdin, or message');
  }

  let target: SingleShotResume | undefined;
  if (resume) {
    const { resolveSingleShotResume } = await import('#src/commands/singleShotResume.js');
    const resolved = await resolveSingleShotResume(config, resume.ref, resume.surface);
    if (!resolved) {
      // Refused by the seam, which has said why. Nothing ran.
      setExitCode(1);
      return;
    }
    target = resolved;
  }

  const { runSingleShot } = await import('@gaunt-sloth/core/runtime/singleShot.js');
  const { createResolvers } = await import('@gaunt-sloth/agent/resolvers.js');
  const { resolveAgentFactory } = await import('@gaunt-sloth/agent/core/resolveAgentFactory.js');
  let ok = false;
  try {
    ({ ok } = await runSingleShot(
      'ASK',
      getAskSystemPrompt(config),
      content.join('\n'),
      config,
      createResolvers(),
      'ask',
      // ask asks for the lean backend, the only one shipped; config.agent.backend names no other.
      resolveAgentFactory(config, 'lean'),
      // [[EXT-158]] — a person typed this verb and is reading what comes back, so a run that
      // stopped with its own checklist unfinished says so. The harness callers of this same
      // runtime (`batch`, `eval`, `workflow`) deliberately do not set it.
      //
      // [[EXT-178]] — and, on the same reading, this verb is eligible for the end-of-run recap.
      // Eligible, not enabled: the user's `recap` rung decides whether a model call is actually
      // made, and it is `off` unless they said otherwise.
      {
        announceOutstandingWork: true,
        announceRunRecap: true,
        announceResumeHint: true,
        ...(target ? { resume: target } : {}),
      }
    ));
  } catch (error) {
    displayError(error instanceof Error ? error.message : String(error));
    ok = false;
  }

  if (!ok) {
    setExitCode(1);
  }
}
