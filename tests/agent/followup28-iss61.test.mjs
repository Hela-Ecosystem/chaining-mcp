import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ChainingMCPServer } from './.dist/server.js';

test('chaining#28 ISS-61: a cross-cell step without a runtime transport names HELA_RUNTIME_URL', async (t) => {
  const server = new ChainingMCPServer();
  const mcp = server.createMcpServer();
  const client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await mcp.close(); await server.stop(); });
  await mcp.connect(b);
  await client.connect(a);
  const reply = await client.callTool({ name: 'workflow_orchestrator', arguments: {
    workflowId: 'iss61', name: 'n', failFast: true,
    steps: [{ id: 'a', serverName: 'hela-membrane', toolName: 'read_file', parameters: { path: 'x' } }],
  } });
  const result = JSON.parse(reply.content[0].text);
  assert.equal(result.steps[0].status, 'failed');
  assert.match(result.steps[0].error, /HELA_RUNTIME_URL/);
});
