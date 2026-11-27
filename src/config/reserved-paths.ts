import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { orchestratorMode } from './orchestrator-mode.js';

/** Directories an external coordinator owns inside its workspace (chaining-mcp#30). */
const RESERVED_SEGMENTS: ReadonlySet<string> = new Set(['.state.graph', 'scratchs', 'researchs', 'designs', 'provness', 'ref']);

export class ReservedPathError extends Error {
  readonly code = 'MITOSIS_RESERVED_PATH';
  constructor(readonly path: string, readonly segment: string, readonly purpose: string) {
    super(`MITOSIS_RESERVED_PATH: ${purpose} path '${path}' is inside '${segment}/', which the external orchestrator owns`);
    this.name = 'ReservedPathError';
  }
}

/** Hosts such as hela-runtime start cells in their install directory, so cwd is only the last resort. */
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.MITOSIS_WORKSPACE_ROOT?.trim() || env.HELA_WORKSPACE_ROOT?.trim() || process.cwd());
}

const MAX_SYMLINK_HOPS = 40;

function symlinkText(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined; // does not exist yet: nothing to follow
  }
}

/**
 * Where the filesystem would put a write to `target`, resolved one component at a time as the kernel does:
 * a symlink is expanded before any following "..", a relative link is read from its real parent, and a link
 * whose destination does not exist yet is still followed. A chain too long to follow cannot be verified.
 */
export function destinationOf(target: string): string {
  const absolute = isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`;
  const { root } = parse(absolute);
  const pending = absolute.slice(root.length).split(sep);
  let current = root;
  let hops = 0;
  while (pending.length) {
    const part = pending.shift() as string;
    if (!part || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = join(current, part);
    const link = symlinkText(next);
    if (link === undefined) { current = next; continue; }
    if (++hops > MAX_SYMLINK_HOPS) throw new Error(`cannot verify the destination of '${target}'`);
    if (isAbsolute(link)) current = parse(link).root;
    pending.unshift(...(isAbsolute(link) ? link.slice(parse(link).root.length) : link).split(sep));
  }
  return current;
}

function reservedSegment(root: string, target: string): string | undefined {
  const inside = relative(root, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return inside.split(sep).find((segment) => RESERVED_SEGMENTS.has(segment));
}

/**
 * Returns the path to write to. In passive mode that is the verified destination, refused when the path as
 * written or its destination lies in a reserved directory of the workspace; callers must write to the
 * returned path. The check is not atomic against another process changing links at the same moment.
 */
export function assertWritablePath(target: string, purpose: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!orchestratorMode(env).passive) return target;
  const root = workspaceRoot(env);
  const written = resolve(target);
  const destination = destinationOf(target);
  const segment = reservedSegment(root, written) ?? reservedSegment(destinationOf(root), destination);
  if (segment) throw new ReservedPathError(written, segment, purpose);
  return destination;
}
