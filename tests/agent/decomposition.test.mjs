import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planTask } from './.dist/agent/agent.js';

const nativeCalls = (calls) => ({
  health: async () => ({ ok: true }),
  generate: async () => ({
    text: JSON.stringify({ type: 'call', function_calls: calls, confidence: 0.9 }),
    modelUsed: 'mock-needle', latencyMs: 1,
  }),
  confidenceOf: () => 0.9,
  isConfident: () => true,
  resetConversation: async () => undefined,
  stopServer: () => undefined,
});
const failingNeedle = () => ({
  health: async () => ({ ok: true }),
  generate: async () => { throw new Error('engine down'); },
  confidenceOf: () => null,
  isConfident: () => true,
  resetConversation: async () => undefined,
  stopServer: () => undefined,
});
const openrouter = (steps) => ({
  metadata: () => ({ name: 'or', kind: 'remote', model: 'or', capabilities: [] }),
  health: async () => ({ ok: true }),
  generate: async () => ({ text: JSON.stringify(steps), modelUsed: 'or', latencyMs: 1 }),
});
const failingEscalation = () => ({
  health: async () => ({ ok: false }),
  generate: async () => { throw new Error('nope'); },
});
const DECLS = [
  { name: 'alpha', description: 'a' },
  { name: 'beta', description: 'b' },
];

describe('planTask (M7: no heuristic fallback)', () => {
  test('needle chain validated into AgentPlan', async () => {
    const plan = await planTask('do things', 'alpha, beta', undefined, {
      primary: nativeCalls([
        { name: 'alpha', arguments: { x: 1 } },
        { name: 'beta', arguments: { input: 'alpha-output' } },
      ]),
    }, DECLS);
    assert.equal(plan.task, 'do things');
    assert.deepEqual(plan.steps.map(s => s.tool), ['alpha', 'beta']);
    assert.deepEqual(plan.steps[1].dependsOn, [1]); // references prior output → chained
  });

  test('task-grounded steps parallelize', async () => {
    const plan = await planTask('do alpha and beta', 'alpha, beta', undefined, {
      primary: nativeCalls([
        { name: 'alpha', arguments: { x: 'alpha' } },
        { name: 'beta', arguments: { y: 'beta' } },
      ]),
    }, DECLS);
    assert.deepEqual(plan.steps.map(s => s.dependsOn), [[], []]);
  });

  test('needle failure falls to openrouter', async () => {
    const escalation = openrouter([
      { step: 1, task: 'read', tool: 'alpha' },
      { step: 2, task: 'unavailable', tool: 'ghost' },
      { step: 3, task: 'unassigned', recommendedCategory: 'utility' },
      { step: 4, task: 'save', tool: 'beta' },
    ]);
    const generate = escalation.generate;
    escalation.generate = async request => {
      assert.match(request.prompt, /"tool"/);
      assert.match(request.prompt, /alpha/);
      assert.match(request.prompt, /beta/);
      return generate();
    };
    const plan = await planTask('do things', 'alpha', undefined, {
      primary: failingNeedle(),
      escalation,
    }, DECLS);
    assert.equal(plan.source, 'or');
    assert.match(plan.plannerError, /engine down/);
    assert.equal(plan.omittedSteps, 2);
    assert.deepEqual(plan.steps.map(({ step, tool, dependsOn }) => [step, tool, dependsOn]), [
      [1, 'alpha', []], [2, 'beta', [1]],
    ]);
  });

  test('large catalogs are scoped and bounded even when no capability matches', async () => {
    const catalog = Array.from({ length: 376 }, (_, i) => ({ name: `fixture_${i}` }));
    catalog.push({ name: 'list_directory', description: 'List entries in a directory', server: 'hela-membrane' });
    for (const [task, expected] of [['List the directory /tmp', 'hela_membrane_list_directory'], ['fixture_375', 'fixture_375']]) {
      const seen = [];
      const primary = nativeCalls([{ name: expected, arguments: {} }]);
      const generate = primary.generate;
      primary.generate = async request => { seen.push(request.tools); return generate(); };
      const plan = await planTask(task, '', undefined, { primary, escalation: failingEscalation() }, catalog);
      assert.equal(seen.length, 1);
      assert.ok(seen[0].length > 0 && seen[0].length < 10);
      assert.ok(seen[0].some(tool => tool.name === expected));
      assert.equal(plan.steps[0].tool, expected);
    }
  });

  test('all providers down throws honest error (no fake plan)', async () => {
    await assert.rejects(() => planTask('do things', 'alpha', undefined, {
      primary: failingNeedle(),
      escalation: failingEscalation(),
    }, DECLS), /engine down.*nope/);
  });

  test('needle garbage with dead escalation throws, not fake plan', async () => {
    await assert.rejects(() => planTask('do things', 'alpha', undefined, {
      primary: { ...nativeCalls([]), generate: async () => ({ text: '}{{{', modelUsed: 'x', latencyMs: 1 }) },
      escalation: failingEscalation(),
    }, DECLS), /./);
  });

  test('unknown tools filtered; empty chain throws', async () => {
    await assert.rejects(() => planTask('do things', 'alpha', undefined, {
      primary: nativeCalls([{ name: 'ghost', arguments: {} }]),
      escalation: openrouter([{ step: 1, task: 'unavailable', tool: 'ghost' }, { step: 2, task: 'unassigned' }]),
    }, DECLS), /no plan steps.*no registry-backed/);
  });
});
