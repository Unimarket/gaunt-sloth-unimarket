import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LANGCHAIN_CORE = process.env.LANGCHAIN_CORE_DIR;
const SEEN_LOG = process.env.MODEL_SEEN_LOG ?? 'model-seen.json';
const MCP_URL = process.env.MCP_URL ?? 'http://localhost:18080/mcp';

async function loadLangchain() {
  if (!LANGCHAIN_CORE) {
    throw new Error('Set LANGCHAIN_CORE_DIR to the @langchain/core directory of the gth checkout');
  }
  const load = (path) => import(pathToFileURL(`${LANGCHAIN_CORE}/dist/${path}`).href);
  const { BaseChatModel } = await load('language_models/chat_models.js');
  const { AIMessage, AIMessageChunk } = await load('messages/index.js');
  const { ChatGenerationChunk } = await load('outputs.js');
  return { BaseChatModel, AIMessage, AIMessageChunk, ChatGenerationChunk };
}

export async function configure() {
  const { BaseChatModel, AIMessage, AIMessageChunk, ChatGenerationChunk } = await loadLangchain();

  // Calls supplier_search once, then answers with a thought block followed by an answer block,
  // recording every message list it receives so the system prompt can be inspected.
  class ScriptedModel extends BaseChatModel {
    constructor() {
      super({});
      this.seen = [];
    }
    _llmType() {
      return 'scripted';
    }
    bindTools() {
      return this;
    }
    withStructuredOutput() {
      return { invoke: async () => ({ score: 10, rationale: 'scripted' }) };
    }
    _next(messages) {
      this.seen.push(messages.map((m) => ({ type: m._getType(), content: m.content })));
      writeFileSync(SEEN_LOG, JSON.stringify(this.seen, null, 2));
      if (!messages.some((m) => m._getType() === 'tool')) {
        return new AIMessageChunk({
          content: '',
          tool_calls: [
            {
              id: 'c1',
              name: 'mcp__demo__supplier_search',
              args: { query: 'acme', state: 'CONNECTED' },
            },
          ],
        });
      }
      return new AIMessageChunk({
        content: [
          { type: 'text', thought: true, text: 'INTERNAL-THOUGHT-LEAK' },
          { type: 'text', text: 'FINAL ANSWER: found Acme.' },
        ],
      });
    }
    async _generate(messages) {
      const chunk = this._next(messages);
      const text = typeof chunk.content === 'string' ? chunk.content : '';
      return {
        generations: [
          {
            text,
            message: new AIMessage({ content: chunk.content, tool_calls: chunk.tool_calls }),
          },
        ],
      };
    }
    async *_streamResponseChunks(messages) {
      const chunk = this._next(messages);
      yield new ChatGenerationChunk({
        text: typeof chunk.content === 'string' ? chunk.content : '',
        message: chunk,
      });
    }
  }

  return {
    llm: new ScriptedModel(),
    mcpServers: {
      demo: {
        transport: 'http',
        url: MCP_URL,
        headers: { Authorization: 'Bearer TEST-JWT' },
      },
    },
    allowedTools: ['mcp__demo__*'],
    filesystem: 'none',
  };
}
