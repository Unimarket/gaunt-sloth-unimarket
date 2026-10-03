/**
 * `gth eval`'s tool-argument capture and the `tool_args` check, driven through the production path:
 * the suite parser, `runEvalSuite`, the production run-cell adapter (`buildProductionRunCell` →
 * `runSingleShot`), a real lean agent graph, and `writeEvalOutput`. Only the model and the tool are
 * stubs — a scripted `BaseChatModel` that streams its tool calls as argument fragments, and an
 * in-process tool — so there is no key and no network.
 *
 * The scripted model streams each call's arguments split across several chunks, which is the shape
 * that decides whether capture records final arguments: every chunk carries `tool_calls` parsed from
 * its own fragment alone. The spec therefore asserts the exact recorded text, once per call, in both
 * the written `results.json` and the per-case file.
 *
 * A call the model writes as text, which the agent promotes to a native call, is covered with
 * streaming on and off.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import type { GthConfig } from '@gaunt-sloth/core/config.js';
import { StatusLevel } from '@gaunt-sloth/core/core/types.js';
import { resetConsoleLevel, setConsoleLevel } from '@gaunt-sloth/core/utils/consoleLevel.js';
import { peekProjectDir, setProjectDir } from '@gaunt-sloth/core/utils/systemUtils.js';

/** The calls the scripted model makes in its first round, as the fragments it streams them in. */
const STREAMED_CALLS = [
  {
    index: 0,
    id: 'call-1',
    name: 'lookup_customer',
    fragments: ['{"query": "ac', 'me", "filt', 'ers": {"region": "EU"}}'],
  },
  { index: 1, id: 'call-2', name: 'lookup_customer', fragments: ['{"query":', ' "globex"}'] },
];

/** Every tool invocation the stub tool received, in order. */
const toolInvocations: unknown[] = [];

const lookupCustomer = tool(
  async (input) => {
    toolInvocations.push(input);
    return JSON.stringify({ customer: input.query, found: true });
  },
  {
    name: 'lookup_customer',
    description: 'Look up a customer by name.',
    schema: z.object({
      query: z.string(),
      filters: z.object({ region: z.string() }).optional(),
    }),
  }
);

// The production resolvers would load the whole app toolset and dial MCP servers from a unit spec;
// these hand the agent the one stub tool instead.
vi.mock('@gaunt-sloth/agent/resolvers.js', () => ({
  createResolvers: () => ({ resolveTools: async () => [lookupCustomer] }),
}));

/**
 * While no tool result has come back, asks for the two lookups; afterwards, answers with text. On
 * the streaming path each call's arguments arrive as separate `tool_call_chunks` fragments; on the
 * non-streaming path the finished message carries complete `tool_calls`.
 */
class ScriptedLookupModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType(): string {
    return 'scripted';
  }
  bindTools(): unknown {
    return this;
  }
  protected calledTools(messages: BaseMessage[]): boolean {
    return messages.some((message) => ToolMessage.isInstance(message));
  }
  async _generate(messages: BaseMessage[]) {
    const message = this.calledTools(messages)
      ? new AIMessage('Acme is an EU customer.')
      : new AIMessage({
          content: '',
          tool_calls: STREAMED_CALLS.map(({ id, name, fragments }) => ({
            id,
            name,
            args: JSON.parse(fragments.join('')),
          })),
        });
    const text = typeof message.content === 'string' ? message.content : '';
    return { generations: [{ message, text }] };
  }
  /**
   * Reports every chunk to the run manager as it is produced, as provider integrations do; that
   * callback is what puts each chunk, rather than only the finished message, on the graph's
   * `messages` stream.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ) {
    const chunks = this.calledTools(messages)
      ? ['Acme is ', 'an EU customer.'].map(
          (text) => new ChatGenerationChunk({ text, message: new AIMessageChunk(text) })
        )
      : STREAMED_CALLS.flatMap(({ index, id, name, fragments }) =>
          fragments.map(
            (args, position) =>
              new ChatGenerationChunk({
                text: '',
                message: new AIMessageChunk({
                  content: '',
                  tool_call_chunks: [
                    {
                      type: 'tool_call_chunk',
                      index,
                      args,
                      ...(position === 0 ? { id, name } : {}),
                    },
                  ],
                }),
              })
          )
        );
    for (const chunk of chunks) {
      await runManager?.handleLLMNewToken(chunk.text, undefined, undefined, undefined, undefined, {
        chunk,
      });
      yield chunk;
    }
  }
}

/**
 * Writes its tool call as assistant text rather than as a native tool call. The agent's repair
 * middleware promotes that text to a native call under the same message id, after the id has
 * already been streamed as plain text.
 */
class TextEmittingLookupModel extends ScriptedLookupModel {
  private textFor(messages: BaseMessage[]): string[] {
    return this.calledTools(messages)
      ? ['Acme is ', 'an EU customer.']
      : ['[tool:lookup_customer]', '{"query":"acme"}'];
  }
  async _generate(messages: BaseMessage[]) {
    const text = this.textFor(messages).join('');
    return { generations: [{ message: new AIMessage(text), text }] };
  }
  async *_streamResponseChunks(
    messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ) {
    for (const text of this.textFor(messages)) {
      const chunk = new ChatGenerationChunk({ text, message: new AIMessageChunk(text) });
      await runManager?.handleLLMNewToken(text, undefined, undefined, undefined, undefined, {
        chunk,
      });
      yield chunk;
    }
  }
}

const SUITE = `
target: { type: gth-agent }
cases:
  - id: right-args
    prompt: "look up acme"
    must_call: ["lookup_customer"]
    tool_args:
      - { tool: "lookup_customer", path: "query", equals: "acme" }
      - { tool: "lookup_customer", path: "filters.region", matches: "^EU$" }
      - { tool: "lookup_customer", path: "query", matches: "^(acme|globex)$", every: true }
      - { tool: "lookup_customer", path: "limit", absent: true, every: true }
  - id: wrong-args
    prompt: "look up acme"
    tool_args:
      - { tool: "lookup_customer", path: "query", equals: "initech" }
`;

const TEXT_EMITTED_SUITE = `
target: { type: gth-agent }
cases:
  - id: text-emitted
    prompt: "look up acme"
    must_call: ["lookup_customer"]
    tool_args:
      - { tool: "lookup_customer", path: "query", equals: "acme" }
`;

const EXPECTED_TOOL_RESULTS = [
  {
    name: 'lookup_customer',
    isError: false,
    content: '{"customer":"acme","found":true}',
    args: '{"query":"acme","filters":{"region":"EU"}}',
  },
  {
    name: 'lookup_customer',
    isError: false,
    content: '{"customer":"globex","found":true}',
    args: '{"query":"globex"}',
  },
];

const projectDir = mkdtempSync(join(tmpdir(), 'gth-eval-tool-args-spec-'));

function scriptedConfig(streamOutput: boolean, llm: BaseChatModel): GthConfig {
  return {
    llm,
    streamOutput,
    contentSource: 'file',
    requirementSource: 'file',
    filesystem: 'none',
    useColour: false,
    writeOutputToFile: false,
    writeBinaryOutputsToFile: false,
    streamSessionInferenceLog: false,
    canInterruptInferenceWithEsc: false,
    includeCurrentDateAfterGuidelines: false,
    // The documented opt-out: no session rows and an in-memory checkpointer, so the run leaves
    // the developer's own history store untouched.
    history: { enabled: false },
  } as Partial<GthConfig> as GthConfig;
}

/** Run the suite through the production eval path and return what it wrote. */
async function runSuite(
  streamOutput: boolean,
  outputDir: string,
  suite: string = SUITE,
  llm: BaseChatModel = new ScriptedLookupModel()
) {
  const { parseEvalSuite } = await import('@gaunt-sloth/batch/evalSuite.js');
  const { runEvalSuite, classifyEvalExit } = await import('@gaunt-sloth/batch/evalRunner.js');
  const { writeEvalOutput } = await import('@gaunt-sloth/batch/evalOutput.js');
  const { buildProductionRunCell } = await import('#src/commands/batchCommand.js');

  const runCell = await buildProductionRunCell(
    scriptedConfig(streamOutput, llm),
    'PREAMBLE',
    {},
    {
      command: 'ask',
      displayCommand: 'eval',
      origin: 'eval',
      sourcePrefix: 'EVAL',
      wrapBlockPrefix: 'message',
      wrapPrefix: 'user message',
    }
  );
  const summary = await runEvalSuite(parseEvalSuite(suite), { runCell });
  writeEvalOutput(outputDir, summary);

  const read = (file: string) => JSON.parse(readFileSync(join(outputDir, file), 'utf8'));
  return {
    exit: classifyEvalExit(summary),
    results: read('results.json'),
    caseFile: (caseId: string) => read(`${caseId}.json`),
  };
}

let priorProjectDir: string | undefined;

beforeEach(() => {
  vi.resetAllMocks();
  toolInvocations.length = 0;
  priorProjectDir = peekProjectDir();
  setProjectDir(projectDir);
  setConsoleLevel(StatusLevel.ERROR);
});
afterEach(() => {
  setProjectDir(priorProjectDir);
  resetConsoleLevel();
});
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));

describe('gth eval records tool-call arguments and grades tool_args', () => {
  it('writes each streamed call’s final arguments once, and grades them', async () => {
    const run = await runSuite(true, join(projectDir, 'streamed'));

    // The tool really ran with the arguments the fragments assemble into, once per call per case.
    expect(toolInvocations).toEqual([
      { query: 'acme', filters: { region: 'EU' } },
      { query: 'globex' },
      { query: 'acme', filters: { region: 'EU' } },
      { query: 'globex' },
    ]);

    const [right, wrong] = run.results.cases;
    expect(right.id).toBe('right-args');
    expect(right.toolResults).toEqual(EXPECTED_TOOL_RESULTS);
    expect(right.verdict).toBe('PASS');
    expect(right.reasons).toEqual([]);

    expect(wrong.id).toBe('wrong-args');
    expect(wrong.toolResults).toEqual(EXPECTED_TOOL_RESULTS);
    expect(wrong.verdict).toBe('FAIL');
    expect(wrong.reasons).toEqual([
      'tool_args "query" (tool "lookup_customer"): is "acme", expected "initech"; is "globex", ' +
        'expected "initech"',
    ]);

    expect(run.results).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(run.exit).toBe(1);
    // The per-case files carry the same records as the summary.
    expect(run.caseFile('right-args')).toEqual(right);
    expect(run.caseFile('wrong-args')).toEqual(wrong);
  }, 60000);

  it('records the same arguments when the run does not stream', async () => {
    const run = await runSuite(false, join(projectDir, 'invoked'));

    expect(run.results.cases.map((c: { toolResults: unknown }) => c.toolResults)).toEqual([
      EXPECTED_TOOL_RESULTS,
      EXPECTED_TOOL_RESULTS,
    ]);
    expect(run.results.cases.map((c: { verdict: string }) => c.verdict)).toEqual(['PASS', 'FAIL']);
  }, 60000);

  describe.each([true, false])(
    'a call the model wrote as text (streamOutput: %s)',
    (streamOutput) => {
      it('is promoted, run and recorded with its arguments', async () => {
        const run = await runSuite(
          streamOutput,
          join(projectDir, `text-emitted-${streamOutput}`),
          TEXT_EMITTED_SUITE,
          new TextEmittingLookupModel()
        );

        expect(toolInvocations).toEqual([{ query: 'acme' }]);
        const [textEmitted] = run.results.cases;
        expect(textEmitted.toolResults).toEqual([
          {
            name: 'lookup_customer',
            isError: false,
            content: '{"customer":"acme","found":true}',
            args: '{"query":"acme"}',
          },
        ]);
        expect(textEmitted.verdict).toBe('PASS');
        expect(textEmitted.reasons).toEqual([]);
        expect(run.caseFile('text-emitted')).toEqual(textEmitted);
      }, 60000);
    }
  );
});
