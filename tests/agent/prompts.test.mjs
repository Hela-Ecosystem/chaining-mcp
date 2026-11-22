import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  predefinedPrompts,
  predefinedResourceSets,
  promptCategories,
  resourceSetCategories,
} from './.dist/prompts/prompt-definitions.js';
import { promptResourceTools } from './.dist/tools/prompt-resource-tools.js';
import { AwesomeCopilotIntegration, LOCAL_FALLBACK_NOTICE } from './.dist/integrations/awesome-copilot-integration.js';
import { RequestHandlers } from './.dist/handlers/request-handlers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Tool names per cell, from the checked-in catalog snapshot (or a live catalog). */
function loadCatalogCells() {
  const path = process.env.HELA_TOOL_CATALOG || join(root, 'config', 'tool-catalog.json');
  const catalog = JSON.parse(readFileSync(path, 'utf8'));
  const cells = new Map();
  for (const [cell, entry] of Object.entries(catalog.cells || {})) {
    const names = Array.isArray(entry)
      ? entry
      : (entry.variants || []).flatMap(variant => (variant.tools || []).map(tool => tool.name));
    cells.set(cell, new Set(names.filter(Boolean)));
  }
  return cells;
}

/** Bare catalog name, or runtime-namespaced `hela_<cell>_<tool>`. */
function resolveToolName(name, cells) {
  if (!name.startsWith('hela_')) {
    return [...cells.values()].some(names => names.has(name));
  }
  for (const [cell, names] of cells) {
    const prefix = `${cell.replace(/-/g, '_')}_`;
    if (name.startsWith(prefix)) return names.has(name.slice(prefix.length));
  }
  return false;
}

const toolsByName = Object.fromEntries(promptResourceTools.map(tool => [tool.name, tool]));

test('every expectedTools entry names a tool in the HeLa catalog', () => {
  const cells = loadCatalogCells();
  const unknown = [];
  for (const prompt of predefinedPrompts) {
    for (const name of prompt.expectedTools || []) {
      if (!resolveToolName(name, cells)) unknown.push(`${prompt.id}: ${name}`);
    }
  }
  assert.deepEqual(unknown, [], `prompts reference tools that are not in config/tool-catalog.json:\n${unknown.join('\n')}`);
});

test('prompt and resource-set category enums are derived from the data', () => {
  assert.deepEqual(
    toolsByName.search_prompts.inputSchema.properties.category.enum,
    promptCategories,
  );
  assert.deepEqual(
    toolsByName.search_resource_sets.inputSchema.properties.category.enum,
    resourceSetCategories,
  );

  assert.deepEqual([...new Set(predefinedPrompts.map(p => p.category))].sort(), promptCategories);
  assert.deepEqual([...new Set(predefinedResourceSets.map(r => r.category))].sort(), resourceSetCategories);

  // Every advertised category must actually filter to at least one entry.
  for (const category of promptCategories) {
    assert.ok(predefinedPrompts.some(p => p.category === category), `prompt category '${category}' matches nothing`);
  }
  for (const category of resourceSetCategories) {
    assert.ok(predefinedResourceSets.some(r => r.category === category), `resource category '${category}' matches nothing`);
  }
});

describe('awesome-copilot local fallback', () => {
  const fallbackHandlers = () => new RequestHandlers(
    { getServers: () => [] },
    {},
    {},
    {},
    new AwesomeCopilotIntegration(),
    {},
  );

  test('search_instructions is degraded and warns even when a token is set', async () => {
    const original = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test_token';
    try {
      const handlers = fallbackHandlers();
      await new Promise(resolve => setImmediate(resolve));
      const result = await handlers.handleToolCall('search_instructions', { keywords: 'mcp' });
      assert.equal(result.source, 'local_fallback');
      assert.equal(result.status, 'degraded');
      assert.equal(result.warning, LOCAL_FALLBACK_NOTICE);
      assert.match(result.degraded.reason, /degraded/);
      assert.equal(result.total, 2);
      assert.ok(result.results.every(entry => /stub/i.test(entry.description)));
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });

  test('load_instruction returns a labelled stub, and a miss says so', async () => {
    const handlers = fallbackHandlers();
    await new Promise(resolve => setImmediate(resolve));
    const loaded = await handlers.handleToolCall('load_instruction', {
      mode: 'instructions',
      filename: 'typescript-mcp-server.instructions.md',
    });
    assert.equal(loaded.status, 'degraded');
    assert.equal(loaded.warning, LOCAL_FALLBACK_NOTICE);
    assert.match(loaded.content, /Local stub/i);

    const missing = await handlers.handleToolCall('load_instruction', {
      mode: 'instructions',
      filename: 'reactjs.instructions.md',
    });
    assert.equal(missing.status, 'degraded');
    assert.match(missing.error, /Instruction not found/);
    assert.ok(Array.isArray(missing.available));
  });

  test('no collection entry points at an instruction that cannot be loaded', async () => {
    const integration = new AwesomeCopilotIntegration();
    await new Promise(resolve => setImmediate(resolve));
    const loadable = new Set(integration.getInstructions().map(i => `${i.mode}/${i.filename}`));
    for (const collection of integration.getCollections()) {
      for (const item of collection.items) {
        assert.ok(loadable.has(item.path), `${collection.id} lists unloadable ${item.path}`);
      }
    }
    assert.ok(!integration.getCollections().some(c => c.id === 'frontend-web-dev'));
    assert.equal(integration.searchInstructions('react').length, 0);
  });
});
