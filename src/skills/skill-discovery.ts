import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface SkillInfo {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  files: string[];
  bodyChars: number;
}

export interface SkillDetail extends SkillInfo {
  content: string;
}

function defaultSkillDirs(): string[] {
  if (process.env.MITOSIS_SKILLS_DIRS) {
    return process.env.MITOSIS_SKILLS_DIRS.split(':').filter(Boolean);
  }
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return [
    join(homedir(), '.config', 'opencode', 'skills'),
    join(packageRoot, 'skills'),
  ];
}

interface ParsedFrontmatter {
  data: Record<string, string>;
  body: string;
  error?: string;
}

/** Strip wrapping quotes and a trailing ` # comment` that is not inside them. */
function cleanScalar(value: string): string {
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
    return value.slice(1, -1);
  }
  const comment = value.search(/\s#/);
  return (comment >= 0 ? value.slice(0, comment) : value).trim();
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const data: Record<string, string> = {};
  // Normalize Windows checkouts before parsing frontmatter delimiters and keys.
  const text = raw.replace(/\r\n?/g, '\n');
  if (!text.startsWith('---')) return { data, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    return { data, body: text, error: 'frontmatter opened with --- but never closed' };
  }

  const head = text.slice(3, end);
  let currentKey: string | undefined;
  let block: { style: '|' | '>'; indent: number; lines: string[] } | undefined;

  const flushBlock = () => {
    if (!currentKey || !block) return;
    data[currentKey] = block.style === '|' ? block.lines.join('\n') : block.lines.join(' ');
    block = undefined;
  };

  for (const rawLine of head.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (block) {
      const indent = (line.match(/^\s*/) ?? [''])[0].length;
      if (line.trim() === '' || indent >= block.indent) {
        block.lines.push(line.trim());
        continue;
      }
      flushBlock();
    }
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) {
      // Continuation of a wrapped value; keeps `description: >` and plain wraps working.
      if (currentKey && /^\s+/.test(line)) {
        data[currentKey] = `${data[currentKey]} ${line.trim()}`.trim();
      }
      continue;
    }
    const key = m[1];
    const value = m[2].trim();
    currentKey = key;
    // Block scalars may carry chomping/indentation indicators (`>-`, `|+2`).
    const blockMatch = /^([|>])[+-]?\d*$/.exec(value);
    if (blockMatch) {
      block = {
        style: blockMatch[1] as '|' | '>',
        indent: (line.match(/^\s*/) ?? [''])[0].length + 2,
        lines: [],
      };
      data[key] = '';
      continue;
    }
    data[key] = cleanScalar(value);
  }
  flushBlock();

  return { data, body: text.slice(end + 4).trim() };
}

function listFilesRecursive(dir: string, base: string, out: string[], depth = 0): void {
  if (depth > 3) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) listFilesRecursive(full, base, out, depth + 1);
    else if (st.size < 500000) out.push(full.slice(base.length + 1));
  }
}

/**
 * Local skill-catalog discovery (opencode AgentSkills layout: one dir per
 * skill with SKILL.md frontmatter). Read-only: never executes skill scripts.
 */
export class SkillDiscovery {
  private cache: { key: string; at: number; skills: SkillInfo[] } | undefined;
  /** Files that looked like skills but could not be parsed (name -> reason). */
  private parseErrors = new Map<string, string>();
  private readonly cacheTtlMs = 10000;

  /** Scan with short TTL cache (per directory-set) so hot guidance paths
   *  don't re-read every SKILL.md on each call. */
  scan(dirs: string[] = defaultSkillDirs()): SkillInfo[] {
    const key = JSON.stringify(dirs);
    const now = Date.now();
    if (this.cache && this.cache.key === key && now - this.cache.at < this.cacheTtlMs) {
      return this.cache.skills;
    }
    const skills = this.scanFresh(dirs);
    this.cache = { key, at: now, skills };
    return skills;
  }

  clearCache(): void {
    this.cache = undefined;
    this.parseErrors.clear();
  }

  /** Parse failures observed by the last scan, for honest "not found" answers. */
  parseFailures(): Array<{ skill: string; reason: string }> {
    return [...this.parseErrors.entries()].map(([skill, reason]) => ({ skill, reason }));
  }

  private scanFresh(dirs: string[]): SkillInfo[] {
    const skills: SkillInfo[] = [];
    const seen = new Set<string>();
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const skillDir = join(dir, e);
        const skillFile = join(skillDir, 'SKILL.md');
        if (!existsSync(skillFile)) continue;
        try {
          const text = readFileSync(skillFile, 'utf8');
          const { data, body, error } = parseFrontmatter(text);
          if (error) {
            this.parseErrors.set(e, `${skillFile}: ${error}`);
            continue;
          }
          this.parseErrors.delete(e);
          const name = data.name || e;
          if (seen.has(name)) continue;
          const files: string[] = [];
          listFilesRecursive(skillDir, skillDir, files);
          seen.add(name);
          skills.push({
            name,
            description: data.description || '',
            shortDescription: data['short-description'],
            path: skillDir,
            files,
            bodyChars: body.length,
          });
        } catch {
          continue;
        }
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  search(query: string, dirs?: string[]): SkillInfo[] {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
    if (!words.length) return [];
    return this.scan(dirs)
      .map(s => {
        const hay = `${s.name} ${s.description} ${s.shortDescription || ''}`.toLowerCase();
        const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
        return { s, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .map(({ s }) => s);
  }

  get(name: string, dirs?: string[], file = 'SKILL.md'): SkillDetail | undefined {
    const found = this.scan(dirs).find(s => s.name === name);
    if (!found) return undefined;
    if (!file || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..') || !found.files.includes(file)) return undefined;
    try {
      const text = readFileSync(join(found.path, file), 'utf8');
      const { body } = parseFrontmatter(text);
      return { ...found, content: body };
    } catch {
      return undefined;
    }
  }
}

let shared: SkillDiscovery | undefined;

/** Process-wide skill catalog (scan is cheap; always fresh per call site). */
export function sharedSkills(): SkillDiscovery {
  if (!shared) shared = new SkillDiscovery();
  return shared;
}
