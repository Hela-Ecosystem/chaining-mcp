import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { agentRun } from './.dist/agent/agent.js';
import { AgentStateManager } from './.dist/agent/state.js';

const TOOLS = [{ name: 'alpha', description: 'first tool' }, { name: 'beta', description: 'second tool' }];
const exec = (impl = async (t, a) => ({ t, a })) => ({ executeTool: impl });
const okProvider = (text, model = 'mock') => ({
  metadata: () => ({ name: 'mock', kind: 'local', model, capabilities: [] }),
  health: async () => ({ ok: true }),
  generate: async () => ({ text, modelUsed: model, latencyMs: 1 }),
});
const scriptProvider = (texts) => {
  let i = 0;
  return {
    metadata: () => ({ name: 'script', kind: 'local', model: 'script', capabilities: [] }),
    health: async () => ({ ok: true }),
    generate: async () => ({ text: texts[Math.min(i++, texts.length - 1)], modelUsed: 'script', latencyMs: 1 }),
  };
};
const failingProvider = (msg) => ({
  metadata: () => ({ name: 'fail', kind: 'local', model: 'fail', capabilities: [] }),
  health: async () => ({ ok: true }),
  generate: async () => { throw Object.assign(new Error(msg), { code: 'UNKNOWN', retryable: true }); },
});
const call = (tool, args = {}) => JSON.stringify({ action: 'call_tool', tool, args });
const done = (result = 'ok') => JSON.stringify({ action: 'complete', result });

describe('agent loop', () => {
  test('single tool call then complete', async () => {
    const seen = [];
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS,
      executor: exec(async (t, a) => { seen.push([t, a]); return { r: 1 }; }),
      providers: { primary: scriptProvider([call('alpha', { x: 1 }), done('fin')]) },
      limits: { maxIterations: 4, maxToolCalls: 3, maxExecutionMs: 5000 },
    });
    assert.deepEqual(seen, [['alpha', { x: 1 }]]);
    assert.equal(run.decision.action, 'complete');
    assert.equal(run.escalated, false);
  });

  test('unknown tool rejected, loop continues', async () => {
    const seen = [];
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS,
      executor: exec(async (t) => { seen.push(t); return {}; }),
      providers: { primary: scriptProvider([call('ghost'), call('beta'), done()]) },
      limits: { maxIterations: 5, maxToolCalls: 3, maxExecutionMs: 5000 },
    });
    assert.deepEqual(seen, ['beta']);
    assert.equal(run.toolCalls, 1);
  });

  test('identical successful re-call is skipped and only a planner decision completes the run', async () => {
    let n = 0;
    const state = new AgentStateManager();
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS,
      executor: exec(async () => { n++; return { v: 42 }; }),
      providers: { primary: scriptProvider([call('alpha'), call('alpha'), done(42)]) },
      limits: { maxIterations: 5, maxToolCalls: 5, maxExecutionMs: 5000 },
      state: { manager: state },
    });
    assert.equal(n, 1);
    assert.equal(run.iterations, 3);
    assert.deepEqual(run.decision, { action: 'complete', result: 42 });
    const decisions = state.snapshot(run.sessionId).events.filter(event => event.kind === 'decision');
    assert.deepEqual(decisions.at(-1).decision, run.decision);
  });

  test('a repeated call cannot report completion at the iteration limit', async () => {
    const state = new AgentStateManager();
    let calls = 0;
    await assert.rejects(agentRun({
      task: 't', toolSchemas: TOOLS,
      executor: exec(async () => { calls++; return { v: 42 }; }),
      providers: { primary: okProvider(call('alpha')) },
      limits: { maxIterations: 3 },
      state: { manager: state, sessionId: 'repeated' },
    }), /iteration limit/);
    assert.equal(calls, 1);
    assert.equal(state.stats('repeated').terminated, 'iteration_limit');
  });

  for (const [label, payload] of [
    ['success:false', { success: false, message: 'bad path' }],
    ['JSON text with ok:false', '{"ok":false,"error":"bad path"}'],
    ['error object', { error: { message: 'bad path' } }],
    ['MCP isError', { isError: true, content: [{ type: 'text', text: 'bad path' }] }],
    ['MCP structured payload', { structuredContent: { success: false, message: 'bad path' } }],
    ['MCP text payload', { content: [{ type: 'text', text: '{"success":false,"message":"bad path"}' }] }],
  ]) {
    test(`${label} is recorded as a failure and can be recovered`, async () => {
      const state = new AgentStateManager();
      let observed;
      let attempts = 0;
      const primary = scriptProvider([call('alpha'), done(payload), call('alpha'), done('recovered')]);
      const generate = primary.generate;
      primary.generate = async (request) => {
        if (attempts === 1 && observed === undefined) observed = request.prompt;
        return generate(request);
      };
      const run = await agentRun({
        task: 't', toolSchemas: TOOLS,
        executor: exec(async () => ++attempts === 1 ? payload : 'recovered'),
        providers: { primary },
        state: { manager: state },
      });
      assert.equal(run.toolCalls, 2);
      assert.equal(run.decision.result, 'recovered');
      assert.match(observed, /ERROR.*bad path/i);
      assert.equal(state.stats(run.sessionId).errors, 1);
      const failure = state.snapshot(run.sessionId).events.find(event => event.kind === 'tool_result');
      assert.match(failure.error, /bad path/);
      assert.deepEqual(failure.result, payload);
    });
  }

  test('a current-time question scopes the catalog and rejects a file call', async () => {
    const calls = [];
    const clock = 'hela_mitosis_get_current_time';
    const task = 'Tell me the current time in Asia/Jakarta. Do not modify any files.';
    const primary = scriptProvider([call('hela_membrane_read_file'), call(clock, { timezone: 'Asia/Jakarta' }), done('07:00 WIB')]);
    const generate = primary.generate;
    const catalogs = [];
    primary.generate = (request) => {
      catalogs.push(request.tools.map(t => t.name));
      return generate(request);
    };
    const run = await agentRun({
      task,
      toolSchemas: [{ name: 'hela_membrane_write_file' }, { name: clock }, { name: 'hela_membrane_read_file' }],
      executor: exec(async (tool, args) => { calls.push([tool, args]); return { datetime: '07:00 WIB' }; }),
      providers: { primary },
    });
    assert.deepEqual(catalogs, [[clock], [clock], [clock]]);
    assert.deepEqual(calls, [[clock, { timezone: 'Asia/Jakarta' }]]);
    assert.deepEqual(run.decision, { action: 'complete', result: '07:00 WIB' });
  });

  test('a current-time question without a clock returns an explicit refusal', async () => {
    const state = new AgentStateManager();
    const run = await agentRun({
      task: 'What time is it in Asia/Jakarta?', toolSchemas: [{ name: 'read_file' }],
      executor: exec(async () => assert.fail('called an unrelated tool')),
      providers: { primary: okProvider(call('read_file')) },
      state: { manager: state },
    });
    assert.equal(run.toolCalls, 0);
    assert.equal(run.decision.action, 'escalate');
    assert.match(run.decision.reason, /no current-time tool/i);
    assert.deepEqual(state.snapshot(run.sessionId).events.at(-1).decision, run.decision);
  });

  test('iteration limit enforced', async () => {
    await assert.rejects(() => agentRun({
      task: 't', toolSchemas: TOOLS, executor: exec(),
      providers: { primary: scriptProvider([JSON.stringify({ action: 'revise', note: 'again' })]) },
      limits: { maxIterations: 2, maxToolCalls: 3, maxExecutionMs: 5000 },
    }), /iteration limit/);
  });

  test('tool call limit enforced', async () => {
    await assert.rejects(() => agentRun({
      task: 't', toolSchemas: TOOLS, executor: exec(),
      providers: { primary: scriptProvider([call('alpha'), call('beta'), call('alpha', { z: 1 })]) },
      limits: { maxIterations: 8, maxToolCalls: 2, maxExecutionMs: 5000 },
    }), /tool call limit/);
  });

  test('malformed primary output escalates', async () => {
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS, executor: exec(),
      providers: { primary: scriptProvider(['not json{{{']), escalation: okProvider(done('via-escalation')) },
      limits: { maxIterations: 4, maxToolCalls: 3, maxExecutionMs: 5000 },
    });
    assert.equal(run.escalated, true);
    assert.equal(run.decision.result, 'via-escalation');
  });

  test('primary failure escalates; escalation failure carries observation count', async () => {
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS, executor: exec(),
      providers: { primary: failingProvider('boom'), escalation: okProvider(done('recovered')) },
      limits: { maxIterations: 4, maxToolCalls: 3, maxExecutionMs: 5000 },
    });
    assert.equal(run.escalated, true);
    await assert.rejects(() => agentRun({
      task: 't', toolSchemas: TOOLS, executor: exec(),
      providers: { primary: scriptProvider([call('alpha'), 'garbage{{{']), escalation: failingProvider('down') },
      limits: { maxIterations: 5, maxToolCalls: 3, maxExecutionMs: 5000 },
    }), /prior observations/);
  });

  test('unhealthy primary starts escalated', async () => {
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS, executor: exec(),
      providers: { primary: { ...okProvider(done('e')), health: async () => ({ ok: false, detail: 'nope' }) }, escalation: okProvider(done('e')) },
      limits: { maxIterations: 3, maxToolCalls: 3, maxExecutionMs: 5000 },
    });
    assert.equal(run.escalated, true);
  });

  test('tool errors feed back, loop continues', async () => {
    let n = 0;
    const run = await agentRun({
      task: 't', toolSchemas: TOOLS,
      executor: exec(async () => { if (++n === 1) throw new Error('kaput'); return 'fixed'; }),
      providers: { primary: scriptProvider([call('alpha'), call('beta'), done('recovered')]) },
      limits: { maxIterations: 5, maxToolCalls: 4, maxExecutionMs: 5000 },
    });
    assert.equal(n, 2);
    assert.equal(run.decision.action, 'complete');
  });

  test('no provider key auto-detected → agent_run hands off, no dead-end call', async () => {
    const saved = { or: process.env.OPENROUTER_API_KEY, oa: process.env.OPENAI_API_KEY, esc: process.env.AGENT_ESCALATION_ENABLED };
    delete process.env.OPENROUTER_API_KEY; delete process.env.OPENAI_API_KEY; delete process.env.AGENT_ESCALATION_ENABLED;
    try {
      const run = await agentRun({
        task: 't', toolSchemas: TOOLS, executor: exec(),
        providers: { primary: scriptProvider([JSON.stringify({ action: 'escalate', reason: 'stuck' })]) },
        limits: { maxIterations: 5, maxToolCalls: 3, maxExecutionMs: 5000 },
      });
      assert.equal(run.handoff, true);
      assert.equal(run.escalated, true);
      assert.equal(run.decision.action, 'escalate');
      assert.match(run.decision.reason, /no escalation provider configured/);
    } finally {
      if (saved.or !== undefined) process.env.OPENROUTER_API_KEY = saved.or;
      if (saved.oa !== undefined) process.env.OPENAI_API_KEY = saved.oa;
      if (saved.esc !== undefined) process.env.AGENT_ESCALATION_ENABLED = saved.esc;
    }
  });
});
