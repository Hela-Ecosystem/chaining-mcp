// chaining-mcp#30: passive mode for external DAG coordinators.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { orchestratorMode, isToolAllowed } from './.dist/config/orchestrator-mode.js';
import { assertWritablePath, ReservedPathError } from './.dist/config/reserved-paths.js';
import { RunStore } from './.dist/agent/run-store.js';
import { isAgentEnabled } from './.dist/agent/diagnostics.js';
import { ChainingMCPServer } from './.dist/server.js';

const ENTRY = fileURLToPath(new URL('./.dist/index.js', import.meta.url));
const ALLOWED = [
  'analyze_tool_chain_performance', 'analyze_tools', 'convert_time', 'get_current_time', 'get_prompt',
  'get_resource_set', 'get_skill', 'get_tool_chain_analysis', 'list_mcp_servers', 'list_skills',
  'load_instruction', 'search_instructions', 'search_prompts', 'search_resource_sets', 'search_skills',
  'validate_tool_chain',
];
const LLM = ['llm_query', 'llm_summarize'];
const OMITTED = [
  'agent_run', 'workflow_orchestrator', 'workflow_status', 'workflow_cancel', 'sequentialthinking',
  'analyze_with_sequential_thinking', 'generate_route_suggestions', 'suggest_skill_chain', 'brainstorming',
  'llm_decompose_task', 'llm_suggest_route',
];
const RESERVED = ['.state.graph', 'scratchs', 'researchs', 'designs', 'provness', 'ref'];

async function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
  apply(values);
  try { return await run(); } finally { apply(saved); }
}

function snapshot(root, at = root, out = {}) {
  for (const entry of readdirSync(at, { withFileTypes: true })) {
    const file = path.join(at, entry.name);
    const key = path.relative(root, file);
    if (entry.isDirectory()) { out[`${key}/`] = true; snapshot(root, file, out); }
    else out[key] = entry.isFile() ? `${statSync(file).mtimeMs}:${readFileSync(file).toString('base64')}` : 'link';
  }
  return out;
}

describe('orchestrator mode resolution', () => {
  test('unset, empty and blank keep autonomous mode; any other value is a coordinator', () => {
    for (const value of [undefined, '', '   ']) {
      assert.deepEqual(orchestratorMode({ MITOSIS_EXTERNAL_ORCHESTRATOR: value }), { passive: false, externalOrchestrator: null });
    }
    for (const value of ['meta7', 'passive', ' other ', 'false']) {
      assert.deepEqual(orchestratorMode({ MITOSIS_EXTERNAL_ORCHESTRATOR: value }), { passive: true, externalOrchestrator: value.trim() });
    }
  });

  test('passive mode beats MITOSIS_AGENT_ENABLED=true and ignores the profiles', async () => {
    for (const profile of [undefined, 'minimal', 'web-devops']) {
      await withEnv({ MITOSIS_EXTERNAL_ORCHESTRATOR: 'meta7', MITOSIS_AGENT_ENABLED: 'true', HELA_PROFILE: profile, HELA_POLICY_PROFILE: profile }, () => {
        assert.equal(isAgentEnabled(), false);
        assert.ok(!isToolAllowed('agent_run'));
        assert.ok(isToolAllowed('get_current_time'));
      });
    }
    await withEnv({ MITOSIS_EXTERNAL_ORCHESTRATOR: undefined, MITOSIS_AGENT_ENABLED: 'false' }, () => assert.equal(isAgentEnabled(), false));
  });

  test('a tool that is not on the allow-list is hidden by default', () => {
    assert.equal(isToolAllowed('some_future_orchestrator', { MITOSIS_EXTERNAL_ORCHESTRATOR: 'passive' }), false);
    assert.equal(isToolAllowed('some_future_orchestrator', {}), true);
  });
});

describe('reserved coordinator paths', () => {
  test('segments, traversal and symlinks are refused; look-alikes are not', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mitosis-reserved-'));
    try {
      for (const dir of [...RESERVED, 'reference', 'src']) mkdirSync(path.join(root, dir), { recursive: true });
      symlinkSync(path.join(root, 'ref'), path.join(root, 'src', 'link'));
      symlinkSync(path.join(root, 'src'), path.join(root, 'designs', 'out'));
      const env = { MITOSIS_EXTERNAL_ORCHESTRATOR: 'meta7', MITOSIS_WORKSPACE_ROOT: root };
      // Links whose destination does not exist yet, directly and through a second link.
      symlinkSync(path.join(root, 'ref', 'not-yet.json'), path.join(root, 'src', 'dangling'));
      symlinkSync('dangling', path.join(root, 'src', 'chain'));
      const at = (relative) => `${root}/${relative}`;
      const refused = [
        ...RESERVED.map((dir) => at(`${dir}/file.db`)), at('ref/a/b.json'),
        at('src/../ref/x'), at('src/link/x'), at('designs/out/x'), at('nested/scratchs/x'), at('src/dangling'), at('src/chain'),
      ];
      for (const target of refused) assert.throws(() => assertWritablePath(target, 'test', env), ReservedPathError, target);
      for (const target of [at('reference/x'), at('src/refs.json'), at('memory.db'), path.join(os.tmpdir(), 'ref', 'outside')]) {
        assert.doesNotThrow(() => assertWritablePath(target, 'test', env), target);
      }
      // A relative path is where the process would write it, and a blank override falls back to cwd.
      const previous = process.cwd();
      process.chdir(at('ref'));
      try {
        assert.throws(() => assertWritablePath('x.json', 'test', env), ReservedPathError);
        process.chdir(root);
        assert.throws(() => assertWritablePath('ref/x', 'test', { ...env, MITOSIS_WORKSPACE_ROOT: '   ' }), ReservedPathError);
      } finally {
        process.chdir(previous);
      }
      assert.doesNotThrow(() => assertWritablePath(at('ref/x'), 'test', { MITOSIS_WORKSPACE_ROOT: root }), 'autonomous mode is unchanged');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('passive mode keeps run state in memory, even with HELA_RUNSTORE_PATH set', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mitosis-runstore-'));
    try {
      await withEnv({ MITOSIS_EXTERNAL_ORCHESTRATOR: 'meta7', HELA_RUNSTORE_PATH: path.join(root, 'runs.db') }, () => {
        const store = new RunStore();
        store.createRun('x', { runId: 'r1' });
        assert.equal(store.getRun('r1').run.id, 'r1');
        store.close();
        new RunStore(path.join(root, 'explicit.db')).close();
      });
      assert.deepEqual(readdirSync(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function connectStdio(cwd, env, log) {
  const client = new Client({ name: 'passive-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], cwd, env: { PATH: process.env.PATH, HOME: cwd, ...env }, stderr: log ? 'pipe' : 'ignore' });
  if (log) transport.stderr.on('data', (chunk) => log.push(String(chunk)));
  await client.connect(transport);
  return client;
}

async function freePort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

const names = async (client) => (await client.listTools()).tools.map((tool) => tool.name).sort();
const SAMPLE_ARGS = {
  get_current_time: { timezone: 'UTC' }, convert_time: { source_timezone: 'UTC', time: '12:00', target_timezone: 'Asia/Jakarta' },
  validate_tool_chain: { toolChain: [] }, search_prompts: { query: 'review' }, search_resource_sets: { query: 'web' },
  search_skills: { query: 'review' }, get_skill: { name: 'missing' }, get_prompt: { id: 'missing' }, get_resource_set: { id: 'missing' },
};

describe('passive server over stdio', () => {
  for (const llm of ['true', 'false']) {
    test(`tools/list and direct calls follow the allow-list (CHAINING_LLM_ENABLED=${llm}); nothing is written, no engine starts`, async () => {
      const scratch = mkdtempSync(path.join(os.tmpdir(), 'mitosis-passive-'));
      const workspace = path.join(scratch, 'workspace');
      const marker = path.join(scratch, 'engine-started');
      const engine = path.join(scratch, 'needle');
      try {
        for (const dir of RESERVED) {
          mkdirSync(path.join(workspace, dir), { recursive: true });
          writeFileSync(path.join(workspace, dir, 'keep.txt'), dir);
        }
        writeFileSync(engine, `#!/bin/sh\ntouch '${marker}'\n`);
        chmodSync(engine, 0o755);
        // Client configs name other MCP servers; a passive server must not launch any of them.
        mkdirSync(path.join(workspace, '.config', 'mcp'), { recursive: true });
        writeFileSync(path.join(workspace, '.config', 'mcp', 'servers.json'), JSON.stringify({ mcpServers: Object.fromEntries(
          ['trap', 'awesome-copilot'].map((name) => [name, { command: engine, args: [] }]),
        ) }));
        const before = snapshot(workspace);
        const log = [];
        const client = await connectStdio(workspace, {
          MITOSIS_EXTERNAL_ORCHESTRATOR: 'meta7', MITOSIS_AGENT_ENABLED: 'true', CHAINING_LLM_ENABLED: llm,
          NEEDLE_ENGINE_PATH: engine, NEEDLE_MODEL_PATH: engine, AGENT_ESCALATION_ENABLED: 'false', GITHUB_TOKEN: 'fixture-token',
        }, log);
        try {
          // The very first call is a refused one: it must not start discovery.
          assert.equal((await client.callTool({ name: 'agent_run', arguments: { task: 'x' } })).isError, true);
          assert.doesNotMatch(log.join(''), /Initializing chaining MCP server/);
          assert.deepEqual(await names(client), [...ALLOWED, ...(llm === 'true' ? LLM : [])].sort());
          for (const name of ALLOWED) {
            const result = await client.callTool({ name, arguments: SAMPLE_ARGS[name] ?? {} });
            assert.doesNotMatch(result.content[0].text, /MITOSIS_PASSIVE_MODE/, name);
          }
          assert.ok(!(await client.callTool({ name: 'get_current_time', arguments: { timezone: 'UTC' } })).isError);
          for (const name of [...OMITTED, ...(llm === 'false' ? LLM : [])]) {
            const result = await client.callTool({ name, arguments: { task: 'x' } });
            assert.equal(result.isError, true, name);
            const body = JSON.parse(result.content[0].text);
            assert.deepEqual(
              [body.ok, body.code, body.mode, body.externalOrchestrator, body.tool],
              [false, 'MITOSIS_PASSIVE_MODE', 'passive', 'meta7', name],
            );
          }
        } finally {
          await client.close();
        }
        assert.deepEqual(snapshot(workspace), before);
        assert.ok(!existsSync(marker), 'a process (Needle engine or configured server) was started');
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    });
  }

  test('without the variable the autonomous surface is unchanged', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'mitosis-auto-'));
    try {
      const client = await connectStdio(workspace, { MITOSIS_AGENT_ENABLED: 'true' });
      try {
        const listed = await names(client);
        for (const name of [...ALLOWED, ...OMITTED, ...LLM]) assert.ok(listed.includes(name), name);
      } finally {
        await client.close();
      }
      assert.ok(existsSync(path.join(workspace, 'hela-runs.db')));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('passive server over HTTP', () => {
  test('same filtering and refusal, and healthz only adds fields', async () => {
    await withEnv({ MITOSIS_EXTERNAL_ORCHESTRATOR: 'passive', CHAINING_LLM_ENABLED: 'true' }, async () => {
      const server = new ChainingMCPServer();
      const port = await freePort();
      const logged = [];
      const original = console.error;
      await server.start({ transport: 'http', port, host: '127.0.0.1' });
      const client = new Client({ name: 'passive-http', version: '1.0.0' });
      try {
        const health = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
        assert.deepEqual(Object.keys(health), ['status', 'server', 'role', 'transport', 'version', 'protocolVersion', 'mode', 'externalOrchestrator']);
        assert.deepEqual([health.status, health.mode, health.externalOrchestrator], ['ok', 'passive', 'passive']);
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
        assert.deepEqual(await names(client), [...ALLOWED, ...LLM].sort());
        console.error = (...args) => logged.push(args.join(' '));
        for (const name of OMITTED) {
          const result = await client.callTool({ name, arguments: {} });
          assert.equal(result.isError, true, name);
          assert.equal(JSON.parse(result.content[0].text).code, 'MITOSIS_PASSIVE_MODE', name);
        }
        assert.doesNotMatch(logged.join('\n'), /Initializing chaining MCP server/);
      } finally {
        console.error = original;
        try { await client.close(); } finally { await server.stop(); }
      }
    });
  });
});
