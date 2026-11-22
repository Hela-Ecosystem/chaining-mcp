import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RequestHandlers } from './.dist/handlers/request-handlers.js';
import { WorkflowOrchestrator } from './.dist/managers/workflow-orchestrator.js';
import { NeedleProvider } from './.dist/agent/needle-provider.js';
import { TimeManager } from './.dist/managers/time-manager.js';
import { ChainingMCPServer } from './.dist/server.js';
import { createRuntimeTransport } from './.dist/transport/runtime-transport.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');

// Milestone 8: exercise the real MCP handler paths with stubbed discovery.
const fakeTools = [
  { name: 'get_weather', description: 'Get weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }, serverName: 'test', category: 'utility' },
  { name: 'get_time', description: 'Get current time', inputSchema: { type: 'object', properties: {}, }, serverName: 'test', category: 'utility' },
];

function handlers(transport) {
  const o = new WorkflowOrchestrator();
  if (transport) o.setTransport(transport);
  const h = new RequestHandlers(
    { getTools: () => fakeTools },
    {}, {}, {}, {},
    o, undefined,
  );
  return { h, o };
}

const localTransport = async (server, tool, params) => {
  if (tool === 'get_weather') return { temp_c: 27, sky: 'clear', city: params.city };
  if (tool === 'get_time') return { time: '12:00' };
  throw new Error(`unknown tool ${tool}`);
};

async function connectMcp(t, options) {
  const server = new ChainingMCPServer(options);
  const mcp = server.createMcpServer();
  const client = new Client({ name: 'workflow-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await mcp.close();
    await server.stop();
  });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return async (name, args) => {
    const reply = await client.callTool({ name, arguments: args });
    assert.equal(reply.isError, undefined);
    return JSON.parse(reply.content[0].text);
  };
}

describe('M8 handler surface', () => {
  test('MCP workflow dispatches to the named cell and retains Mitosis local tools', async (t) => {
    const seen = [];
    const runtimeTransport = async (cell, tool, args, signal) => {
      seen.push([cell, tool, args]);
      assert.ok(signal instanceof AbortSignal);
      return { source: cell };
    };
    const call = await connectMcp(t, { runtimeTransport });
    const workflow = await call('workflow_orchestrator', {
      workflowId: 'named-cell-workflow', name: 'named cell', failFast: true,
      steps: [
        { id: 'a', serverName: 'hela-mitosis', toolName: 'get_current_time', parameters: { timezone: 'UTC' } },
        { id: 'b', serverName: 'hela-membrane', toolName: 'get_current_time', parameters: { path: 'fixture' }, dependsOn: ['a'] },
      ],
    });
    assert.equal(workflow.status, 'completed');
    assert.equal(workflow.steps[0].result.timezone, 'UTC');
    assert.deepEqual(workflow.steps[1].result, { source: 'hela-membrane' });
    assert.deepEqual(seen, [['hela-membrane', 'get_current_time', { path: 'fixture' }]]);
  });

  test('MCP workflow routes through hela.pipe and retries a returned runtime error', async (t) => {
    const calls = [];
    const runtime = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks));
      if (request.method === 'notifications/initialized') {
        res.writeHead(202).end();
        return;
      }
      let result;
      if (request.method === 'initialize') {
        result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'runtime-fixture', version: '1' } };
      } else {
        calls.push(request.params);
        const failed = calls.length === 1;
        const payload = failed ? { ok: false, error: 'temporarily unavailable' } : {
          ok: true,
          results: [{ ok: true, result: { content: [{ type: 'text', text: '{"size":42}' }] } }],
        };
        result = { isError: failed, content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
    runtime.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => runtime.close(resolve)));
    await once(runtime, 'listening');
    const runtimeTransport = createRuntimeTransport(new URL(`http://127.0.0.1:${runtime.address().port}/mcp`));
    const call = await connectMcp(t, { runtimeTransport });
    const workflow = await call('workflow_orchestrator', {
      workflowId: 'pipe-workflow', name: 'pipe', failFast: true,
      steps: [{ id: 'a', serverName: 'hela-membrane', toolName: 'hela_membrane_get_file_info', parameters: { path: 'fixture' }, retryOnFailure: true, maxRetries: 1 }],
    });
    const request = { name: 'hela.pipe', arguments: { steps: [{ cell: 'hela-membrane', tool: 'get_file_info', args: { path: 'fixture' } }] } };
    assert.deepEqual(calls, [request, request]);
    assert.equal(workflow.status, 'completed');
    assert.equal(workflow.steps[0].retryCount, 1);
    assert.deepEqual(workflow.steps[0].result, { size: 42 });
  });

  test('MCP workflow without a runtime fails sibling steps and honors local errors', async (t) => {
    const call = await connectMcp(t);
    const sibling = await call('workflow_orchestrator', {
      workflowId: 'no-runtime-workflow', name: 'no runtime',
      steps: [{ id: 'a', serverName: 'hela-membrane', toolName: 'get_current_time', parameters: {} }],
    });
    assert.equal(sibling.status, 'failed');
    assert.match(sibling.steps[0].error, /runtime transport.*hela-membrane/i);

    const local = await call('workflow_orchestrator', {
      workflowId: 'local-error-workflow', name: 'local error', failFast: true,
      steps: [
        { id: 'a', serverName: 'hela-mitosis', toolName: 'get_current_time', parameters: { timezone: 'invalid/timezone' }, retryOnFailure: true },
        { id: 'b', serverName: 'hela-mitosis', toolName: 'get_current_time', parameters: {}, dependsOn: ['a'] },
      ],
    });
    assert.equal(local.status, 'failed');
    assert.equal(local.steps.length, 1);
    assert.equal(local.steps[0].status, 'failed');
    assert.equal(local.steps[0].retryCount, 1);
  });

  test('workflow_status / workflow_cancel round-trip', async () => {
    const { h, o } = handlers(localTransport);
    const wf = await o.executeWorkflow({ workflowId: 'wstat', name: 'w', steps: [{ id: 'a', serverName: 't', toolName: 'get_time', parameters: {} }] });
    assert.equal(wf.status, 'completed');
    const st = await h.handleToolCall('workflow_status', { workflowId: 'wstat' });
    assert.equal(st.ok, true);
    assert.equal(st.status, 'completed');
    const missing = await h.handleToolCall('workflow_status', { workflowId: 'nope' });
    assert.equal(missing.ok, false);
    const cancelIdle = await h.handleToolCall('workflow_cancel', { workflowId: 'wstat' });
    assert.equal(cancelIdle.ok, false); // already completed, not running
  });

  test('workflow steps execute against bound transport (no placeholder)', async () => {
    const { h } = handlers(localTransport);
    const r = await h.handleToolCall('workflow_orchestrator', {
      workflowId: 'wreal', name: 'w',
      steps: [{ id: 'a', serverName: 't', toolName: 'get_weather', parameters: { city: 'Jakarta' } }],
    });
    assert.equal(r.status, 'completed');
    assert.deepEqual(r.steps[0].result, { temp_c: 27, sky: 'clear', city: 'Jakarta' });
  });

  test('agent_run disabled with explicit opt-out', async () => {
    process.env.MITOSIS_AGENT_ENABLED = 'false';
    const { h } = handlers(localTransport);
    const r = await h.handleToolCall('agent_run', { task: 'hi' });
    assert.equal(r.ok, false);
    assert.match(r.error, /disabled/);
    delete process.env.MITOSIS_AGENT_ENABLED;
  });

  test('agent_run can use its local clock when discovery lists only unrelated tools', async (t) => {
    const enabled = process.env.MITOSIS_AGENT_ENABLED;
    process.env.MITOSIS_AGENT_ENABLED = 'true';
    t.after(() => {
      if (enabled === undefined) delete process.env.MITOSIS_AGENT_ENABLED;
      else process.env.MITOSIS_AGENT_ENABLED = enabled;
    });
    const timezone = 'Asia/Jakarta';
    const call = { name: 'get_current_time', arguments: { timezone } };
    const replies = [
      { type: 'call', function_calls: [call] },
      { action: 'call_tool', tool: call.name, args: call.arguments },
      { action: 'complete', result: timezone },
    ];
    t.mock.method(NeedleProvider.prototype, 'health', async () => ({ ok: true }));
    t.mock.method(NeedleProvider.prototype, 'generate', async request => {
      assert.deepEqual(request.tools.map(tool => tool.name), [call.name]);
      return { text: JSON.stringify(replies.shift()), modelUsed: 'mock', latencyMs: 1 };
    });
    const o = new WorkflowOrchestrator();
    const h = new RequestHandlers({ getTools: () => fakeTools }, {}, new TimeManager(), {}, {}, o);
    const executed = [];
    o.setTransport(async (_server, tool, args) => {
      const result = await h.handleToolCall(tool, args);
      executed.push([tool, result.timezone]);
      return result;
    });
    const run = await h.handleToolCall('agent_run', { task: 'Tell me the current time in Asia/Jakarta. Do not modify any files.' });
    assert.equal(run.ok, true);
    assert.equal(run.decision.action, 'complete');
    assert.equal(run.iterations, 2);
    assert.deepEqual(executed, [[call.name, timezone]]);
  });

  test('brainstorming keyless fails honestly (no template ideas)', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const { h } = handlers(localTransport);
      const r = await h.handleToolCall('brainstorming', { topic: 'onboarding', thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false });
      assert.equal(r.ok, false);
      assert.match(r.error, /generative model/);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  test('skills catalog: list/search/get over fixtures', async () => {
    process.env.MITOSIS_SKILLS_DIRS = FIXTURES;
    try {
      const { h } = handlers(localTransport);
      const list = await h.handleToolCall('list_skills', {});
      assert.equal(list.ok, true);
      assert.deepEqual(list.skills.map(s => s.name), ['deploy-bot', 'weather-helper']);
      const search = await h.handleToolCall('search_skills', { query: 'blue-green deploy' });
      assert.equal(search.skills[0].name, 'deploy-bot');
      const get = await h.handleToolCall('get_skill', { name: 'weather-helper' });
      assert.equal(get.ok, true);
    assert.equal(get.file, 'SKILL.md');
      assert.ok(get.content.includes('plain words'));
      const miss = await h.handleToolCall('get_skill', { name: 'ghost' });
      assert.equal(miss.ok, false);
    } finally {
      delete process.env.MITOSIS_SKILLS_DIRS;
    }
  });
});

describe('M8 agent_run live', { skip: process.env.NEEDLE_LIVE === '1' ? false : 'needs NEEDLE_LIVE=1 and fetched engine' }, () => {
  test('agent_run end-to-end through handler (mock tools, live Needle)', async () => {
    process.env.MITOSIS_AGENT_ENABLED = 'true';
    const { h } = handlers(localTransport);
    const r = await h.handleToolCall('agent_run', { task: 'get weather in Jakarta', maxExecutionMs: 90000 });
    // The 45M model is stochastic: it may complete via tools, or escalate
    // (which fails keyless here). Either way the loop must have run — a
    // crash-shaped error fails this test.
    if (r.ok) {
      assert.ok(r.workflowId);
      assert.ok(Array.isArray(r.plan));
      assert.ok(r.stateStats);
    } else {
      assert.match(r.error, /escalation|escalated|budget spent/i);
    }
    delete process.env.MITOSIS_AGENT_ENABLED;
  });

  test('sequentialthinking becomes one Needle-backed agent step', async () => {
    process.env.MITOSIS_AGENT_ENABLED = 'true';
    const { h } = handlers(localTransport);
    const r = await h.handleToolCall('sequentialthinking', {
      thought: 'need the Jakarta weather first',
      thoughtNumber: 1, totalThoughts: 3, nextThoughtNeeded: true,
      task: 'get weather in Jakarta',
    });
    // Legacy-shaped fields preserved for compat callers.
    assert.equal(r.thoughtNumber, 1);
    assert.equal(typeof r.nextThoughtNeeded, 'boolean');
    // Agent-shaped fields prove the refined path ran.
    assert.equal(r.source, 'needle-agent');
    assert.ok(r.sessionId);
    assert.ok(r.decision && typeof r.decision.action === 'string');
    assert.ok(r.state);
    // Second thought continues the same session.
    const r2 = await h.handleToolCall('sequentialthinking', {
      thought: 'weather known, wrap up',
      thoughtNumber: 2, totalThoughts: 3, nextThoughtNeeded: false,
      task: 'get weather in Jakarta', sessionId: r.sessionId,
    });
    assert.equal(r2.sessionId, r.sessionId);
    delete process.env.MITOSIS_AGENT_ENABLED;
  });

  test('analyze_with_sequential_thinking plans with Needle, no templates', async () => {
    process.env.MITOSIS_AGENT_ENABLED = 'true';
    const { h } = handlers(localTransport);
    const r = await h.handleToolCall('analyze_with_sequential_thinking', { problem: 'get weather in Jakarta' });
    assert.equal(r.source, 'needle-agent');
    assert.ok(r.thoughts.length >= 1);
    assert.ok(r.thoughts.every(t => t.content.includes(':')));
    assert.ok(r.suggestions[0].tools.length >= 1);
    assert.ok(!JSON.stringify(r).match(/REVERSE ENGINEERING|COOKING ANALOGY|SERENDIPITY/));
    delete process.env.MITOSIS_AGENT_ENABLED;
  });

  test('route suggestions come from Needle, not heuristic ranker', async () => {
    const { h } = handlers(localTransport);
    const r = await h.handleToolCall('generate_route_suggestions', { task: 'get weather in Jakarta' });
    assert.equal(r.source, 'needle');
    assert.equal(r.totalRoutes, 1);
    assert.ok(r.routes[0].reasoning.includes('Needle'));
    process.env.CHAINING_LLM_ENABLED = 'true';
    try {
      const r2 = await h.handleToolCall('llm_suggest_route', { task: 'get weather in Jakarta' });
      assert.equal(r2.ok, true);
      assert.equal(r2.source, 'needle');
      assert.ok(r2.routes[0].tools.length >= 1);
    } finally {
      delete process.env.CHAINING_LLM_ENABLED;
    }
  });
});
