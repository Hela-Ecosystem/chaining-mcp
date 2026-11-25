import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestHandlers } from './.dist/handlers/request-handlers.js';
import { WorkflowOrchestrator } from './.dist/managers/workflow-orchestrator.js';
import { NeedleProvider } from './.dist/agent/needle-provider.js';

const tools = [{ name: 'read_file', description: 'Read a file', serverName: 'hela-membrane', inputSchema: { type: 'object' } }];

for (const planner of ['llm_suggest_route', 'generate_route_suggestions', 'llm_decompose_task', 'suggest_skill_chain']) {
  test(`chaining#28 ISS-62: ${planner} gets the model budget, not the interactive 10s limit`, async (t) => {
    const saved = { flag: process.env.MITOSIS_AGENT_ENABLED, ms: process.env.CHAINING_TOOL_TIMEOUT_MS };
    process.env.MITOSIS_AGENT_ENABLED = 'true';
    process.env.CHAINING_TOOL_TIMEOUT_MS = '150';
    t.after(() => {
      for (const [k, v] of [['MITOSIS_AGENT_ENABLED', saved.flag], ['CHAINING_TOOL_TIMEOUT_MS', saved.ms]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
    t.mock.method(NeedleProvider.prototype, 'generate', async () => {
      await new Promise(resolve => setTimeout(resolve, 400));
      return { text: '[{"name":"read_file","arguments":{}}]', modelUsed: 'needle', latencyMs: 400 };
    });
    const h = new RequestHandlers({ getTools: () => tools }, {}, {}, {}, {}, new WorkflowOrchestrator());
    const result = await h.handleToolCall(planner, { task: 'read a file' });
    assert.doesNotMatch(String(result?.error ?? ''), /timed out/);
  });
}
