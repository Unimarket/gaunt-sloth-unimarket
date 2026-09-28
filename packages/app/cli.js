#!/usr/bin/env node

// Suppress deprecation warnings programmatically
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning' || warning.name === 'ExperimentalWarning') {
    return;
  }
  console.warn(warning);
});

// --- ACP server ------------------------------------------------------------
// `gaunt-sloth --acp-agent` is the ACP (Agent Client Protocol) door into the fat
// `gaunt-sloth` package. It serves ACP over stdio — v1 or v2, whichever the host
// asks for — through the SAME startup as the standalone `gaunt-sloth-acp` bin, so
// the two doors cannot behave differently, including the redirect that keeps
// stdout free for JSON-RPC.
//
// The switch is handled here rather than left to fall through to the normal CLI,
// which would answer an ACP host with a chat session on stdout and hang it.
//
// A startup failure goes to stderr: to an ACP host stdout is the JSON-RPC framing
// channel, so prose written there is a protocol error, not a message.
if (process.argv.includes('--acp-agent')) {
  const { setEntryPoint } = await import('@gaunt-sloth/core/utils/systemUtils.js');
  setEntryPoint(import.meta.url);
  const { startAcpServer } = await import('@gaunt-sloth/agent/modules/acp/acpStdio.js');
  try {
    await startAcpServer();
  } catch (err) {
    process.stderr.write(
      `Gaunt Sloth ACP agent failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exit(1);
  }
} else {
  // --- React build selection (TUI-C55) ------------------------------------
  // React chooses its build ONCE, the first time `react/index.js` is evaluated:
  //
  //     if (process.env.NODE_ENV === 'production') require('./cjs/react.production.js');
  //     else                                       require('./cjs/react.development.js');
  //
  // Nothing re-reads NODE_ENV afterwards. So an assignment that runs even one
  // import too late is SILENTLY INERT: the CLI still works, every test still
  // passes, and every Ink render still pays for the development reconciler's
  // prop/hook bookkeeping and warning machinery. There is no error to notice.
  //
  // WHY IT SITS EXACTLY HERE, and what breaks if you move it:
  //
  //  * It must run before React is first evaluated. This file has NO static
  //    imports — both branches use dynamic `await import(...)` — and ESM hoists
  //    static `import` declarations and evaluates them before any body
  //    statement. So a single static import added anywhere in this file could be
  //    evaluated ahead of this line and freeze React on the development build.
  //    Keep this file import-free. For the same reason this must not be "tidied"
  //    into a helper module imported from here: the import would be evaluated
  //    first, and the assignment would then be decorative.
  //
  //  * It must NOT run before the `--acp-agent` branch above. That branch is
  //    documented to start ACP through the same path as the standalone
  //    `gaunt-sloth-acp` bin so the two doors cannot behave differently, and
  //    that bin sets no NODE_ENV. Hoisting this to the top of the file would
  //    make the two doors diverge. React is only ever loaded down this branch
  //    (it lives in packages/app/src/tui/**), so this is both the earliest
  //    correct place and the latest safe one.
  //
  // Guarded, not unconditional: a developer running from source, a `NODE_ENV=test`
  // vitest run, or an operator with their own value keeps it (overriding this is
  // supported and is what `react-build.tui.test.ts` uses as its live control).
  //
  // GTH_SYNTHESIZED_NODE_ENV records that WE invented the value. A user's own
  // `production` is byte-identical to ours, so without this marker the child-env
  // builder could not tell "drop it, we made it up" from "keep it, the operator
  // set it". It travels by environment rather than by module state because it has
  // to cross into packages/agent, which this file cannot import from.
  // See packages/agent/src/tools/shell/env.ts (buildCommandEnv).
  //
  // Proof this still works: packages/app/tui-e2e/react-build.tui.test.ts asserts a
  // real PTY run of THIS entry point loads react.production.js, and its sibling
  // case asserts an explicit NODE_ENV still wins.
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
    process.env.GTH_SYNTHESIZED_NODE_ENV = '1';
  }

  // This is a minimalistic entry point that sets the installDir in systemUtils
  // and delegates to the compiled TypeScript code in dist/cli.js.
  // systemUtils lives in @gaunt-sloth/core (the app-side re-export shim died in
  // GS2-2 B4); importing it from core directly binds the same module instance
  // the rest of the app reads, so setEntryPoint state is shared as before.
  const { setEntryPoint } = await import('@gaunt-sloth/core/utils/systemUtils.js');

  // Set the installation directory in systemUtils
  setEntryPoint(import.meta.url);

  // Import and run the compiled TypeScript code
  import('./dist/cli.js').catch((err) => {
    console.error('Failed to load application:', err);
    process.exit(1);
  });
}
