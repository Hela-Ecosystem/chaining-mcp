import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MCPServerDiscovery } from '../../dist/core/discovery.js';

function catalog() {
  return {
    format: 1,
    cells: {
      'hela-membrane': {
        revision: 'deadbeef',
        version: '3.0.5',
        variants: [{ features: {}, tools: [
          { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } },
          { name: 'write_file', description: 'write', inputSchema: { type: 'object', properties: {} } },
        ] }],
      },
    },
  };
}

test('runtime catalog contributes cells and tools when client configs are empty', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hela-catalog-'));
  const previous = process.env.HELA_ECOSYSTEM_ROOT;
  try {
    await mkdir(path.join(root, 'config'), { recursive: true });
    await writeFile(path.join(root, 'config', 'tool-catalog.json'), JSON.stringify(catalog()));
    process.env.HELA_ECOSYSTEM_ROOT = root;

    const discovery = new MCPServerDiscovery();
    await discovery.discoverServers(true);

    const servers = discovery.getServers().map(server => server.name);
    assert.ok(servers.includes('hela-membrane'), `catalog cell missing from ${JSON.stringify(servers)}`);

    const tools = discovery.getTools();
    const readFile = tools.find(tool => tool.name === 'read_file');
    assert.ok(readFile, 'catalog tool missing');
    assert.equal(readFile.serverName, 'hela-membrane');
  } finally {
    if (previous === undefined) delete process.env.HELA_ECOSYSTEM_ROOT;
    else process.env.HELA_ECOSYSTEM_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
