import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillDiscovery } from './.dist/skills/skill-discovery.js';
import { RequestHandlers } from './.dist/handlers/request-handlers.js';
import { WorkflowOrchestrator } from './.dist/managers/workflow-orchestrator.js';

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'skills-fixture-'));
}

function writeSkill(root, dir, frontmatter, body = 'Body text.') {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

function handlersFor(root) {
  process.env.MITOSIS_SKILLS_DIRS = root;
  return new RequestHandlers(
    { getTools: () => [] }, {}, {}, {}, {}, new WorkflowOrchestrator(), undefined,
  );
}

test('chaining#26: quoted frontmatter values lose their quotes', () => {
  const root = fixtureRoot();
  try {
    writeSkill(root, 'quoted', 'name: "quoted-skill"\ndescription: \'Single quoted description\'');
    const [skill] = new SkillDiscovery().scan([root]);
    assert.equal(skill.name, 'quoted-skill');
    assert.equal(skill.description, 'Single quoted description');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chaining#26: block scalars are not leaked as indicators', () => {
  const root = fixtureRoot();
  try {
    writeSkill(root, 'literal', 'name: literal\ndescription: |\n  First line.\n  Second line.');
    writeSkill(root, 'folded', 'name: folded\ndescription: >\n  Folded into\n  one line.');
    const skills = new SkillDiscovery().scan([root]);
    const literal = skills.find(s => s.name === 'literal');
    const folded = skills.find(s => s.name === 'folded');
    assert.equal(literal.description, 'First line.\nSecond line.');
    assert.equal(folded.description, 'Folded into one line.');
    assert.ok(!/\|/.test(literal.description));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chaining#26: block scalars with chomping indicators keep the text only', () => {
  const root = fixtureRoot();
  try {
    writeSkill(root, 'chomped', 'name: chomped\ndescription: >-\n  Folded without\n  a trailing newline.');
    const [skill] = new SkillDiscovery().scan([root]);
    assert.equal(skill.description, 'Folded without a trailing newline.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chaining#26: inline comments are dropped from scalars', () => {
  const root = fixtureRoot();
  try {
    writeSkill(root, 'commented', 'name: commented # trailing note\ndescription: Plain value');
    const [skill] = new SkillDiscovery().scan([root]);
    assert.equal(skill.name, 'commented');
    assert.equal(skill.description, 'Plain value');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('chaining#26: an unparseable SKILL.md is named, not reported as unknown', async () => {
  const root = fixtureRoot();
  try {
    mkdirSync(join(root, 'broken'), { recursive: true });
    writeFileSync(join(root, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: never closed\n');
    const handlers = handlersFor(root);
    const result = await handlers.handleToolCall('get_skill', { name: 'broken' });
    assert.equal(result.ok, false);
    assert.match(result.error, /unknown skill/);
    assert.equal(result.parseFailures.length, 1);
    assert.match(result.parseFailures[0].reason, /never closed/);
    assert.match(result.parseFailures[0].reason, /SKILL\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.MITOSIS_SKILLS_DIRS;
  }
});

test('chaining#26: maxChars bounds the whole response, not only content', async () => {
  const root = fixtureRoot();
  try {
    writeSkill(root, 'large', 'name: large\ndescription: Many files');
    for (let i = 0; i < 300; i++) {
      mkdirSync(join(root, 'large', 'references'), { recursive: true });
      writeFileSync(join(root, 'large', 'references', `file-${i}.md`), `# ${i}\n`);
    }
    const handlers = handlersFor(root);
    const result = await handlers.handleToolCall('get_skill', { name: 'large', maxChars: 2000 });
    assert.equal(result.ok, true);
    const size = JSON.stringify(result).length;
    assert.ok(size <= 2000, `response was ${size} chars, over the 2000 cap`);
    assert.equal(result.files.length, 0);
    assert.ok(result.filesOmitted > 0, 'the omitted count is reported');
    // Ecosystem contract: lossy answers carry status=degraded with a reason.
    assert.equal(result.status, 'degraded');
    assert.match(result.degraded.reason, /maxChars/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.MITOSIS_SKILLS_DIRS;
  }
});

test('chaining#26: a small skill still returns its files and content', async () => {
  const root = fixtureRoot();
  try {
    writeSkill(root, 'small', 'name: small\ndescription: One file');
    const handlers = handlersFor(root);
    const result = await handlers.handleToolCall('get_skill', { name: 'small', maxChars: 8000 });
    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ['SKILL.md']);
    assert.match(result.content, /Body text/);
    assert.equal(result.filesOmitted, undefined);
    assert.equal(result.status, undefined, 'a complete answer is not marked degraded');
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete process.env.MITOSIS_SKILLS_DIRS;
  }
});
