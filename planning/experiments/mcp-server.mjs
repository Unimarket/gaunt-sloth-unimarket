import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const SDK = process.env.MCP_SDK_DIR;
if (!SDK) {
  throw new Error(
    'Set MCP_SDK_DIR to the @modelcontextprotocol/sdk dist/esm directory, with a trailing slash'
  );
}
const { Server } = await import(SDK + 'server/index.js');
const { StreamableHTTPServerTransport } = await import(SDK + 'server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(SDK + 'types.js');

const PORT = Number(process.env.PORT || 18080);
const LOG = process.env.CALL_LOG || 'server-calls.log';
writeFileSync(LOG, '');
const SUPPLIERS = [
  {
    identifier: { uuid: '3f2a6c1e-0d4b-4b6e-9a57-1c2d3e4f5a6b', name: 'Acme Industrial Supplies' },
    name: 'Acme Industrial Supplies',
    externalSupplierId: 'ACME01',
    state: { value: 'CONNECTED', displayable: 'Connected' },
  },
  {
    identifier: { uuid: '9b1d2c3e-1111-4222-8333-444455556666', name: 'Harbour Office Products' },
    name: 'Harbour Office Products',
    externalSupplierId: null,
    state: { value: 'CONNECTED', displayable: 'Connected' },
  },
];
const text = (obj, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  isError,
});

function buildServer() {
  const server = new Server(
    { name: 'demo-mcp', version: '0.0.1' },
    {
      capabilities: { tools: {} },
      instructions:
        'EXPERIMENT RULE 1: never show internal UUIDs to the user. EXPERIMENT RULE 2: call user_current first for dates.',
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'supplier_search',
        description: 'Search suppliers by name or externalSupplierId.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' }, state: { type: 'string' } },
        },
      },
      {
        name: 'supplier_get',
        description: 'Get a supplier by its internal UUID.',
        inputSchema: {
          type: 'object',
          properties: { supplierId: { type: 'string' } },
          required: ['supplierId'],
        },
      },
      {
        name: 'user_current',
        description: 'Current user and date.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    appendFileSync(LOG, JSON.stringify({ name, args }) + '\n');
    if (name === 'supplier_search') {
      const q = (args?.query ?? '').toString().toLowerCase();
      const hits = SUPPLIERS.filter(
        (s) =>
          !q || s.name.toLowerCase().includes(q) || (s.externalSupplierId ?? '').toLowerCase() === q
      );
      return text({
        suppliers: hits,
        page: { total: hits.length, page: 0, pageSize: 20, totalPages: 1 },
      });
    }
    if (name === 'supplier_get') {
      const s = SUPPLIERS.find((x) => x.identifier.uuid === args?.supplierId);
      return s
        ? text(s)
        : text({ code: 'SUPPLIER_NOT_FOUND', description: 'No such supplier.' }, true);
    }
    if (name === 'user_current')
      return text({ userId: 'u-1', currentDateTime: '2026-10-03T00:00:00Z' });
    return text({ code: 'UNKNOWN_TOOL' }, true);
  });
  return server;
}

http
  .createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    appendFileSync(
      LOG,
      JSON.stringify({ http: req.method, auth: req.headers.authorization ?? null }) + '\n'
    );
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    let body = '';
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  })
  .listen(PORT, () => console.log('mcp server on', PORT));
