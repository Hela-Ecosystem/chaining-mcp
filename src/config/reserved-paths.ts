import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
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

function linkDestination(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? resolve(dirname(path), readlinkSync(path)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a write to `target` would really land: symlinks are followed in the part that exists, including a
 * link whose destination does not exist yet. A chain too long to follow cannot be verified, so it throws.
 */
function realTarget(target: string, hops = 0): string {
  try {
    return realpathSync(target);
  } catch {
    if (hops > MAX_SYMLINK_HOPS) throw new Error(`cannot verify the destination of '${target}'`);
    const destination = linkDestination(target);
    if (destination) return realTarget(destination, hops + 1);
    const parent = dirname(target);
    return parent === target ? target : join(realTarget(parent, hops), basename(target));
  }
}

function reservedSegment(root: string, target: string): string | undefined {
  const inside = relative(root, target);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
  return inside.split(sep).find((segment) => RESERVED_SEGMENTS.has(segment));
}

/**
 * Passive mode only: refuses a write whose path, as written or after following
 * symlinks, lands in a reserved directory of the workspace.
 */
export function assertWritablePath(target: string, purpose: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!orchestratorMode(env).passive) return;
  const root = workspaceRoot(env);
  // Relative writes land relative to the process, whatever the workspace root is.
  const written = resolve(target);
  const segment = reservedSegment(root, written) ?? reservedSegment(realTarget(root), realTarget(written));
  if (segment) throw new ReservedPathError(written, segment, purpose);
}
