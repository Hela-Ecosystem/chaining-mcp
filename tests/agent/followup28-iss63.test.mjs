import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RequestHandlers } from './.dist/handlers/request-handlers.js';
import { WorkflowOrchestrator } from './.dist/managers/workflow-orchestrator.js';
import { PromptRegistry } from './.dist/prompts/prompt-registry.js';
import { predefinedPrompts } from './.dist/prompts/prompt-definitions.js';

function skillRoot(t, { description = 'A skill', body = 'Body text.', files = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'followup28-'));
  mkdirSync(join(root, 'logo-design', 'references'), { recursive: true });
  writeFileSync(join(root, 'logo-design', 'SKILL.md'), `---\nname: logo-design\ndescription: ${description}\n---\n${body}\n`);
  for (const f of files) writeFileSync(join(root, 'logo-design', f), 'x\n');
  process.env.MITOSIS_SKILLS_DIRS = root;
  t.after(() => { rmSync(root, { recursive: true, force: true }); delete process.env.MITOSIS_SKILLS_DIRS; });
  return new RequestHandlers({ getTools: () => [] }, {}, {}, {}, {}, new WorkflowOrchestrator(), undefined);
}

test('chaining#28 ISS-63: get_skill tells unknown skill, bad file and disallowed path apart', async (t) => {
  const h = skillRoot(t, { files: ['references/real.md'] });
  const unknown = await h.handleToolCall('get_skill', { name: 'nope' });
  assert.match(unknown.error, /unknown skill 'nope'/);

  const missing = await h.handleToolCall('get_skill', { name: 'logo-design', file: 'references/nope.md' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /file not in skill/);
  assert.doesNotMatch(missing.error, /unknown skill/);
  assert.match(missing.error, /references\/real\.md/);
  assert.ok(missing.available.includes('SKILL.md'));

  for (const file of ['../../../../../etc/hostname', '/etc/hostname', 'a\\b']) {
    const denied = await h.handleToolCall('get_skill', { name: 'logo-design', file });
    assert.match(denied.error, /path not allowed/, file);
  }
  const ok = await h.handleToolCall('get_skill', { name: 'logo-design', file: 'SKILL.md' });
  assert.equal(ok.ok, true);
});

test('chaining#28 ISS-63: maxChars is spent on the body, not the description', async (t) => {
  const h = skillRoot(t, { description: 'd'.repeat(900), body: 'B'.repeat(3000) });
  const r = await h.handleToolCall('get_skill', { name: 'logo-design', maxChars: 500 });
  assert.equal(r.ok, true);
  assert.ok(r.content.length > 400, `content was only ${r.content.length} chars`);
  assert.ok(r.content.length <= 500);
  assert.equal(r.status, 'degraded');
});

test('chaining#28 ISS-63: a category filter with no match returns nothing and says so', async () => {
  const h = new RequestHandlers({ getTools: () => [] }, {}, {}, new PromptRegistry(), {}, new WorkflowOrchestrator());
  const r = await h.handleToolCall('search_prompts', { query: 'debug', category: 'monitoring' });
  assert.equal(r.total, 0);
  assert.deepEqual(r.prompts, []);
  assert.equal(r.matchedDirectly, false);
  assert.match(r.note, /monitoring/);
});

test('chaining#28 ISS-63: expectedTools use cell-prefixed names only', () => {
  const bare = predefinedPrompts.flatMap(p => (p.expectedTools || []).filter(t => !t.startsWith('hela_')).map(t => `${p.id}: ${t}`));
  assert.deepEqual(bare, []);
});
