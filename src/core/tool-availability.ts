import { ToolInfo } from '../types.js';
import { orchestratorMode } from '../config/orchestrator-mode.js';

/**
 * Tool availability, with three outcomes instead of two.
 *
 * A flat "is this name in the list" test cannot tell an absent tool from an
 * undiscovered catalog, and reporting the second as the first makes a validator
 * reject correct plans (chaining-mcp#21).
 */

export interface AvailabilityResult {
  errors: string[];
  warnings: string[];
}

export function indexToolsByServer(availableTools: ToolInfo[]) {
  const byServer = new Map<string, Map<string, ToolInfo>>();
  for (const tool of availableTools) {
    const server = tool.serverName;
    const tools = byServer.get(server) ?? new Map<string, ToolInfo>();
    tools.set(tool.name, tool);
    byServer.set(server, tools);
  }
  return (server: string) => byServer.get(server) ?? byServer.get(`hela-${server}`);
}

export function checkToolAvailability(
  toolChain: { serverName: string; toolName: string }[],
  availableTools: ToolInfo[],
): AvailabilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!availableTools.length) {
    warnings.push('Tool availability could not be verified: no tool catalog was discovered (runtime catalog and client configs are both empty)');
    return { errors, warnings };
  }

  const toolsForServer = indexToolsByServer(availableTools);
  for (const step of toolChain) {
    const tools = toolsForServer(step.serverName);
    if (!tools) {
      warnings.push(`Tool '${step.toolName}' could not be verified: server '${step.serverName}' was not discovered`);
      continue;
    }
    // Passive mode launches no server, so a stand-in list cannot prove that a tool is absent.
    if (!tools.has(step.toolName) && orchestratorMode().passive && [...tools.values()].every((tool) => tool.discoverySource === 'fallback')) {
      warnings.push(`Tool '${step.toolName}' could not be verified: server '${step.serverName}' has only a fallback inventory in passive mode`);
      continue;
    }
    if (!tools.has(step.toolName)) {
      errors.push(`Tool '${step.toolName}' is not available in server '${step.serverName}'`);
    }
  }

  return { errors, warnings };
}
