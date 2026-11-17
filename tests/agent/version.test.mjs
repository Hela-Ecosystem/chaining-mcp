import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MCP_SERVER_VERSION } from './.dist/version.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('advertised MCP server version matches package.json', () => {
  assert.equal(
    MCP_SERVER_VERSION,
    pkg.version,
    'MCP_SERVER_VERSION drifted from package.json version'
  );
});
