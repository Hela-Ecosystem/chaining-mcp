import { test, describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { WorkflowOrchestrator } from './.dist/managers/workflow-orchestrator.js';
import { RunStore } from './.dist/agent/run-store.js';
import { planToWorkflow, runAgentWorkflow } from './.dist/agent/workflow.js';

const okTransport = (impl) => async (server, tool, params, signal) => impl(tool, params, { server, signal });
const scriptProvider = (texts) => {
  let i = 0;
  return {
    metadata: () => ({ name: 's', kind: 'local', model: 's', capabilities: [] }),
    health: async () => ({ ok: true }),
    generate: async () => ({ text: texts[Math.min(i++, texts.length - 1)], modelUsed: 's', latencyMs: 1 }),
  };
};
const call = (tool, args = {}) => JSON.stringify({ action: 'call_tool', tool, args });
const done = (result = 'ok') => JSON.stringify({ action: 'complete', result });

describe('WorkflowOrchestrator transport seam', () => {
  test('unbound workflow fails without fabricating a result', async () => {
    const o = new WorkflowOrchestrator();
    const r = await o.executeWorkflow({ workflowId: 'w1', name: 'w', steps: [{ id: 'a', serverName: 's', toolName: 'thing', parameters: {} }] });
    assert.equal(r.status, 'failed');
    assert.equal(r.steps[0].status, 'failed');
    assert.match(r.steps[0].error, /no transport bound/i);
    assert.equal(r.steps[0].result, undefined);
  });

  test('bound transport receives calls with resolved params', async () => {
    const seen = [];
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport((tool, params) => { seen.push([tool, params]); return { echo: params }; }));
    const r = await o.executeWorkflow({
      workflowId: 'w2', name: 'w', variables: { city: 'Jakarta' },
      steps: [{ id: 'a', serverName: 's', toolName: 'weather', parameters: { city: '$city' } }],
    });
    assert.equal(r.status, 'completed');
    assert.deepEqual(seen, [['weather', { city: 'Jakarta' }]]);
  });

  test('retries actually re-execute (flaky then ok)', async () => {
    let n = 0;
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport(() => { if (++n < 3) throw new Error('flaky'); return { n }; }));
    const r = await o.executeWorkflow({
      workflowId: 'w3', name: 'w',
      steps: [{ id: 'a', serverName: 's', toolName: 't', parameters: {}, retryOnFailure: true, maxRetries: 3 }],
    });
    assert.equal(r.status, 'completed');
    assert.equal(n, 3);
    assert.equal(r.steps[0].retryCount, 2);
  });

  test('returned failure retries and only the successful result reaches dependents', async () => {
    const o = new WorkflowOrchestrator();
    let calls = 0;
    o.setTransport(okTransport((tool, params) => {
      if (tool === 'consume') return params;
      return ++calls === 1 ? { success: false, error: 'transient', value: 'bad' } : { value: 'good' };
    }));
    const r = await o.executeWorkflow({
      workflowId: 'returned-retry', name: 'w', failFast: true,
      steps: [
        { id: 'a', serverName: 's', toolName: 'produce', parameters: {}, retryOnFailure: true },
        { id: 'b', serverName: 's', toolName: 'consume', parameters: {}, dependsOn: ['a'], outputMapping: { value: 'a.value' } },
      ],
    });
    assert.equal(r.status, 'completed');
    assert.equal(calls, 2);
    assert.equal(r.steps[0].retryCount, 1);
    assert.deepEqual(r.steps[1].result, { value: 'good' });
  });

  test('returned failures exhaust configured retries and failFast stops further steps', async () => {
    for (const failFast of [true, false]) {
      const o = new WorkflowOrchestrator();
      const calls = [];
      o.setTransport(okTransport((tool) => {
        calls.push(tool);
        return tool === 'bad' ? { isError: true, content: [{ type: 'text', text: 'offline' }] } : {};
      }));
      const r = await o.executeWorkflow({
        workflowId: `returned-fail-${failFast}`, name: 'w', failFast,
        steps: [
          { id: 'a', serverName: 's', toolName: 'bad', parameters: {}, retryOnFailure: true, maxRetries: 2 },
          { id: 'b', serverName: 's', toolName: 'next', parameters: {}, dependsOn: ['a'] },
        ],
      });
      assert.equal(r.status, 'failed');
      assert.equal(r.steps[0].status, 'failed');
      assert.equal(r.steps[0].error, 'offline');
      assert.equal(r.steps[0].retryCount, 2);
      assert.equal(r.steps[0].result, undefined);
      assert.equal(r.overallResult.summary.failedSteps, 1);
      assert.deepEqual(calls, failFast ? ['bad', 'bad', 'bad'] : ['bad', 'bad', 'bad', 'next']);
    }
  });

  test('resume reports a saved error that was previously recorded as completed', async (t) => {
    const o = new WorkflowOrchestrator();
    const store = new RunStore(':memory:');
    t.after(() => store.close());
    const workflowId = 'legacy-error';
    store.createRun('legacy', { runId: workflowId, workflowId });
    store.startStep(workflowId, 'a', 's', 'bad', {});
    store.saveStepResult(workflowId, 'a', { ok: false, error: 'saved error' });
    store.finishStep(workflowId, 'a', 'completed', 'ok');
    const calls = [];
    o.setTransport(okTransport(tool => { calls.push(tool); return {}; }));
    const r = await o.executeWorkflow({
      workflowId, name: 'w', failFast: true,
      steps: [
        { id: 'a', serverName: 's', toolName: 'bad', parameters: {} },
        { id: 'b', serverName: 's', toolName: 'next', parameters: {}, dependsOn: ['a'] },
      ],
    }, undefined, { runStore: store, resume: true });
    assert.equal(r.status, 'failed');
    assert.equal(r.steps[0].error, 'saved error');
    assert.equal(store.getStep(workflowId, 'a').status, 'failed');
    assert.deepEqual(calls, []);
  });

  test('retries exhausted marks step failed (no failFast)', async () => {
    let n = 0;
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport(() => { n++; throw new Error('always'); }));
    const r = await o.executeWorkflow({
      workflowId: 'w4', name: 'w',
      steps: [{ id: 'a', serverName: 's', toolName: 't', parameters: {}, retryOnFailure: true, maxRetries: 2 }],
    });
    assert.equal(r.status, 'failed');
    assert.equal(n, 3);
  });

  test('no retry config means single attempt', async () => {
    let n = 0;
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport(() => { n++; throw new Error('x'); }));
    const r = await o.executeWorkflow({
      workflowId: 'w5', name: 'w', steps: [{ id: 'a', serverName: 's', toolName: 't', parameters: {} }],
    });
    assert.equal(r.status, 'failed');
    assert.equal(n, 1);
  });

  test('cancelled workflow stops between batches', async () => {
    const order = [];
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport(async (tool) => { order.push(tool); return {}; }));
    const ctl = new AbortController();
    const p = o.executeWorkflow({
      workflowId: 'w6', name: 'w',
      steps: [
        { id: 'a', serverName: 's', toolName: 'first', parameters: {} },
        { id: 'b', serverName: 's', toolName: 'second', parameters: {}, dependsOn: ['a'] },
      ],
    }, ctl.signal);
    ctl.abort();
    const r = await p;
    assert.equal(r.status, 'cancelled');
  });

  test('workflow cancellation and deadline abort an in-flight transport without retrying', async () => {
    for (const timeout of [undefined, 20]) {
      const o = new WorkflowOrchestrator();
      let calls = 0;
      o.setTransport(async (_server, _tool, _args, signal) => {
        calls++;
        await delay(1_000, undefined, { signal });
        return { ok: true };
      });
      const workflowId = timeout ? 'timed-out' : 'cancelled';
      const pending = o.executeWorkflow({
        workflowId, name: 'w', timeout,
        steps: [{ id: 'a', serverName: 's', toolName: 'long', parameters: {}, retryOnFailure: true }],
      });
      if (!timeout) assert.equal(o.cancelWorkflow(workflowId), true);
      const r = await pending;
      assert.equal(r.status, timeout ? 'failed' : 'cancelled');
      assert.match(r.error, timeout ? /timed out/ : /cancelled/);
      assert.equal(r.steps[0].status, 'failed');
      assert.equal(calls, 1);
    }
  });

  test('executeTool registry guard', async () => {
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport((tool) => ({ tool })));
    o.setAllowedTools(['allowed']);
    assert.deepEqual(await o.executeTool('allowed', {}), { tool: 'allowed' });
    await assert.rejects(() => o.executeTool('evil', {}), /not in the agent tool registry/);
    o.clearAllowedTools();
    assert.deepEqual(await o.executeTool('evil', {}), { tool: 'evil' });
  });

  test('executeTool aborted signal throws before transport', async () => {
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport(() => { throw new Error('should not reach'); }));
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(() => o.executeTool('t', {}, { signal: ctl.signal }), /aborted/);
  });
});

describe('planToWorkflow + runAgentWorkflow', () => {
  test('plan maps to dependency-ordered workflow', async () => {
    const { planToWorkflow: p2w } = await import('./.dist/agent/workflow.js');
    const wf = p2w({ task: 't', steps: [
      { step: 1, task: 'a', tool: 'ta', dependsOn: [] },
      { step: 2, task: 'b', tool: 'tb', dependsOn: [1] },
    ] }, { workflowId: 'pw' });
    assert.equal(wf.steps[1].dependsOn[0], 'step-1');
    assert.equal(wf.steps[0].toolName, 'ta');
  });

  test('agent drives orchestrator transport end-to-end (mock provider)', async () => {
    const o = new WorkflowOrchestrator();
    const seen = [];
    o.setTransport(okTransport((tool, params) => { seen.push(tool); return { tool, ok: true }; }));
    const native = (name, args) => JSON.stringify({ type: 'call', function_calls: [{ name, arguments: args }], confidence: 0.9 });
    const needleQueue = (texts) => {
      let i = 0;
      return {
        health: async () => ({ ok: true }),
        generate: async () => ({ text: texts[Math.min(i++, texts.length - 1)], modelUsed: 'mock', latencyMs: 1 }),
        confidenceOf: () => 0.9, isConfident: () => true,
        resetConversation: async () => undefined, stopServer: () => undefined,
      };
    };
    const { run, plan, state } = await runAgentWorkflow({
      task: 'do alpha', toolSchemas: [{ name: 'alpha', description: 'a' }],
      orchestrator: o,
      providers: {
        // M7: planner consumes NATIVE calls only — first entry plans, rest drive the loop.
        primary: needleQueue([
          native('alpha', { q: 0 }),
          native('alpha', { q: 1 }),
          done('finished'),
        ]),
        escalation: scriptProvider([done('unreached')]),
      },
    });
    assert.ok(plan.steps.length >= 1);
    void run;
    void state;
    assert.deepEqual(seen, ['alpha']);
  });

  test('agent cannot escape registry via orchestrator', async () => {
    const o = new WorkflowOrchestrator();
    o.setTransport(okTransport((tool) => ({ tool })));
    const native = (name, args) => JSON.stringify({ type: 'call', function_calls: [{ name, arguments: args }], confidence: 0.9 });
    let i = 0;
    const queue = [native('alpha', {}), native('ghost', {}), native('alpha', {}), done('finished')];
    const { run } = await runAgentWorkflow({
      task: 't', toolSchemas: [{ name: 'alpha' }],
      orchestrator: o,
      providers: {
        primary: {
          metadata: () => ({ name: 's', kind: 'local', model: 's', capabilities: [] }),
          health: async () => ({ ok: true }),
          generate: async () => ({ text: queue[Math.min(i++, queue.length - 1)], modelUsed: 's', latencyMs: 1 }),
        },
      },
    });
    assert.equal(run.decision.action, 'complete');
  });

  test('scopes the clock catalog for both planning and execution', async () => {
    const o = new WorkflowOrchestrator();
    const seen = [];
    const clock = 'hela_mitosis_get_current_time';
    const args = { timezone: 'Asia/Jakarta' };
    const catalogs = [];
    o.setTransport(okTransport((tool, params) => {
      seen.push([tool, params]);
      return { datetime: '07:00 WIB' };
    }));
    const primary = scriptProvider([
      JSON.stringify({ type: 'call', function_calls: [{ name: clock, arguments: args }] }),
      call('hela_membrane_read_file'),
      call(clock, args),
      done('07:00 WIB'),
    ]);
    const generate = primary.generate;
    primary.generate = request => {
      catalogs.push(request.tools.map(tool => tool.name));
      return generate(request);
    };
    const { plan, run } = await runAgentWorkflow({
      task: 'Tell me the current time in Asia/Jakarta. Do not modify any files.',
      toolSchemas: [{ name: 'hela_membrane_read_file' }, { name: clock }, { name: 'hela_membrane_write_file' }],
      orchestrator: o,
      providers: { primary },
    });
    assert.deepEqual(plan.steps.map(step => step.tool), [clock]);
    assert.deepEqual(seen, [[clock, args]]);
    assert.deepEqual(catalogs, [[clock], [clock], [clock], [clock]]);
    assert.equal(run.decision.result, '07:00 WIB');
  });

  test('persists a returned error and an unsuccessful run when the loop runs out of iterations', async (t) => {
    const o = new WorkflowOrchestrator();
    const payload = { success: false, message: 'bad path' };
    o.setTransport(okTransport(() => payload));
    const attach = t.mock.method(o, 'attachRunStore');
    const execute = t.mock.method(o, 'executeTool');
    const native = JSON.stringify({ type: 'call', function_calls: [{ name: 'alpha', arguments: {} }] });
    await assert.rejects(runAgentWorkflow({
      task: 'do alpha', toolSchemas: [{ name: 'alpha' }],
      orchestrator: o,
      providers: { primary: scriptProvider([native, call('alpha')]) },
      limits: { maxIterations: 1 },
    }), /iteration limit/);
    const store = attach.mock.calls[0].arguments[0];
    t.after(() => store.close());
    const { run_id: runId, step_id: stepId } = execute.mock.calls[0].arguments[2].run;
    const { run, events } = store.getRun(runId);
    assert.equal(run.status, 'failed');
    assert.equal(events.at(-1).kind, 'agent_end');
    const step = store.getStep(runId, stepId);
    assert.equal(step.status, 'failed');
    assert.equal(step.result_summary, 'bad path');
    assert.deepEqual(JSON.parse(step.result), payload);
  });
});
