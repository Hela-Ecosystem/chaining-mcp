import { realpathSync } from 'node:fs';
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
  return resolve(env.MITOSIS_WORKSPACE_ROOT || env.HELA_WORKSPACE_ROOT || process.cwd());
}

/** Resolves symlinks in the part of the path that exists and keeps the rest as written. */
function realTarget(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = dirname(target);
    return parent === target ? target : join(realTarget(parent), basename(target));
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
  const written = resolve(root, target);
  const segment = reservedSegment(root, written) ?? reservedSegment(realTarget(root), realTarget(written));
  if (segment) throw new ReservedPathError(written, segment, purpose);
}
