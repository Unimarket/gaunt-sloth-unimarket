# Offline `gth eval` harness

Reproduces `gth eval` behaviour without a real model or the real MCP server: a local MCP server
(`mcp-server.mjs`) and a scripted chat model (`.gsloth.config.mjs`). Use it to check what `gth`
records and what it puts in the system prompt, and as a starting point for spec fixtures.

What it shows against `gth` at upstream `main`:

- the server receives the tool arguments, but `results.json` records only tool names and results;
- the server's `initialize` instructions appear in the system prompt as untrusted, server-provided
  context, after the default persona;
- one streamed tool call yields one `toolResults` entry;
- a `{type: 'text', thought: true}` block does not reach `answer`.

## Run

Needs Node 24 and a built checkout (`<checkout>`).

```bash
export MCP_SDK_DIR=<checkout>/node_modules/.pnpm/@modelcontextprotocol+sdk@<version>/node_modules/@modelcontextprotocol/sdk/dist/esm/
export LANGCHAIN_CORE_DIR=<checkout>/packages/core/node_modules/@langchain/core
node mcp-server.mjs &                                  # port 18080, log in server-calls.log
node <checkout>/packages/app/cli.js eval suite.yaml -o out   # run from this directory
```

`model-seen.json` holds every message list the model received, including the system prompt.
`server-calls.log` holds the arguments the server received. Stop the server afterwards.
