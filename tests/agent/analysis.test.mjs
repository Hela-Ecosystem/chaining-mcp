import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCPServerDiscovery } from './.dist/core/discovery.js';
import { SmartRouteOptimizer } from './.dist/core/optimizer.js';
import { RequestHandlers } from './.dist/handlers/request-handlers.js';

async function fixture(t, cells) {
  const root = await mkdtemp(join(tmpdir(), 'chaining-analysis-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'config'));
  const catalog = {
    cells: Object.fromEntries(Object.entries(cells).map(([cell, tools]) => [
      cell, { variants: [{ tools }] },
    ])),
  };
  await writeFile(join(root, 'config', 'tool-catalog.json'), JSON.stringify(catalog));

  const discovery = new MCPServerDiscovery();
  t.mock.method(discovery, 'helaCatalogPath', async () => join(root, 'config', 'tool-catalog.json'));
  t.mock.method(discovery.configLoader, 'loadConfig', async () => ({ configPaths: [] }));
  t.mock.method(discovery, 'findPackageJsonFiles', async () => []);
  t.mock.method(discovery, 'discoverFromEnvironment', () => []);
  t.mock.method(discovery, 'getEssentialServers', () => []);
  await discovery.discoverServers();

  const handlers = new RequestHandlers(discovery, new SmartRouteOptimizer(discovery.getTools()), {}, {}, {}, {});
  return (name, args) => handlers.handleToolCall(name, args);
}

test('route analysis recommends only matching registry tools and explains incomplete routing', async (t) => {
  const call = await fixture(t, {
    'hela-enzyme': [{ name: 'google_search' }],
    'hela-membrane': [{ name: 'read_file' }, { name: 'write_file' }],
  });

  const result = await call('get_tool_chain_analysis', { input: 'Search the web for a topic and save the results to a file' });
  assert.deepEqual(result.routeRecommendations.map(route => route.tools.map(tool => [tool.serverName, tool.name])), [
    [['hela-enzyme', 'google_search']],
    [['hela-membrane', 'write_file']],
  ]);
  assert.ok(result.routeRecommendations.every(route => route.confidence == null));
  assert.match(result.routeReason, /complete chain/i);
  assert.deepEqual(result.categoryDistribution, { 'hela-enzyme': 1, 'hela-membrane': 2 });
  assert.equal(result.averageComplexity, null);

  const unmatched = await call('get_tool_chain_analysis', { input: 'Translate these sentences' });
  assert.deepEqual(unmatched.routeRecommendations, []);
  assert.match(unmatched.routeReason, /no matching/i);
});

test('tool analysis filters by cell and preserves only available complexity estimates', async (t) => {
  const call = await fixture(t, {
    'hela-enzyme': [{ name: 'google_search', estimatedComplexity: 4 }],
    'hela-membrane': [{ name: 'read_file' }, { name: 'write_file', estimatedComplexity: 2 }],
  });

  const result = await call('analyze_tools', { category: 'hela-membrane' });
  assert.deepEqual(result.categories, ['hela-membrane']);
  assert.deepEqual(result.tools.map(tool => [tool.name, tool.category, tool.complexity]), [
    ['read_file', 'hela-membrane', null],
    ['write_file', 'hela-membrane', 2],
  ]);
});

test('route analysis supports explicit tool names and includes available catalog estimates', async (t) => {
  const call = await fixture(t, {
    'hela-membrane': [{ name: 'find_files', estimatedComplexity: 3, estimatedDuration: 250 }],
  });
  const result = await call('get_tool_chain_analysis', { input: 'Use find_files for this lookup' });
  assert.equal(result.averageComplexity, 3);
  assert.equal(result.routeRecommendations.length, 1);
  assert.equal(result.routeRecommendations[0].name, 'hela-membrane/find_files');
  assert.equal(result.routeRecommendations[0].complexity, 3);
  assert.equal(result.routeRecommendations[0].estimatedDuration, 250);
  assert.equal(result.routeRecommendations[0].confidence, null);
});

const step = (toolName, options = {}) => ({ serverName: 'membrane', toolName, parameters: {}, ...options });

test('performance analysis shares availability diagnostics with chain validation', async (t) => {
  const call = await fixture(t, {
    'hela-membrane': [{ name: 'find_files' }, { name: 'read_file' }],
  });
  const toolChain = [
    step('find_files'),
    step('read_file', { estimatedDuration: 1000, estimatedComplexity: 3 }),
    step('made_up_tool', { serverName: 'hela-nope' }),
    step('another_missing_tool'),
  ];
  const validation = await call('validate_tool_chain', { toolChain });
  assert.equal(validation.errors.length, 1);
  assert.equal(validation.warnings.length, 1);
  const result = await call('analyze_tool_chain_performance', { toolChain });
  assert.deepEqual(result.complexity.riskFactors, [...validation.errors, ...validation.warnings]);
  assert.match(result.complexity.riskFactors.join('\n'), /hela-nope/);
  assert.match(result.complexity.riskFactors.join('\n'), /another_missing_tool/);
  assert.equal(result.metrics.totalEstimatedDuration, null);
  assert.equal(result.metrics.averageComplexity, null);
  assert.deepEqual(result.metrics.bottleneckSteps, []);
  assert.deepEqual(result.complexity.complexityDistribution, { unavailable: 4 });
  assert.equal(result.metrics.parallelizationPotential, 0);

  const withoutComplexity = await call('analyze_tool_chain_performance', {
    toolChain,
    includeComplexityAnalysis: false,
  });
  assert.deepEqual(withoutComplexity.complexity.riskFactors, result.complexity.riskFactors);
});

test('performance analysis uses catalog estimates and identifies parallelism from dependencies', async (t) => {
  const call = await fixture(t, {
    'hela-membrane': [
      { name: 'find_files', estimatedDuration: 0, estimatedComplexity: 1 },
      { name: 'read_file', estimatedDuration: 400, estimatedComplexity: 5 },
      { name: 'write_file', estimatedDuration: 500 },
    ],
  });
  const first = step('find_files', { id: 'find', dependsOn: [] });
  const second = step('read_file', { id: 'read', dependsOn: ['find'] });
  const analyze = toolChain => call('analyze_tool_chain_performance', { toolChain });

  const serial = await analyze([first, second]);
  assert.equal(serial.metrics.totalEstimatedDuration, 400);
  assert.equal(serial.metrics.averageComplexity, 3);
  assert.deepEqual(serial.metrics.bottleneckSteps, ['read']);
  assert.deepEqual(serial.complexity.complexityDistribution, { low: 1, high: 1 });
  assert.equal(serial.metrics.parallelizationPotential, 0);
  assert.equal((await analyze([second, first])).metrics.parallelizationPotential, 0);
  assert.equal((await analyze([first, { ...second, dependsOn: [] }])).metrics.parallelizationPotential, 1);

  const mapping = { ...second, dependsOn: [], outputMapping: { path: 'find.path' } };
  const mixed = await analyze([first, mapping, step('find_files', { dependsOn: [] })]);
  assert.equal(mixed.metrics.parallelizationPotential, 0.5);
  const cyclic = await analyze([{ ...first, dependsOn: ['read'] }, second]);
  assert.equal(cyclic.metrics.parallelizationPotential, null);

  const partial = await analyze([first, step('write_file')]);
  assert.equal(partial.metrics.totalEstimatedDuration, 500);
  assert.equal(partial.metrics.averageComplexity, null);
  assert.deepEqual(partial.complexity.complexityDistribution, { low: 1, unavailable: 1 });
});
