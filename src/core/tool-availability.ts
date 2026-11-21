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

export function checkToolAvailability(toolChain: any[], availableTools: any[]): AvailabilityResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!availableTools.length) {
    warnings.push('Tool availability could not be verified: no tool catalog was discovered (runtime catalog and client configs are both empty)');
    return { errors, warnings };
  }

  const byServer = new Map<string, Set<string>>();
  for (const tool of availableTools) {
    const server = typeof tool.serverName === 'string' ? tool.serverName : 'unknown';
    if (!byServer.has(server)) byServer.set(server, new Set());
    byServer.get(server)!.add(tool.name);
  }

  for (const step of toolChain) {
    const tools = byServer.get(step.serverName) ?? byServer.get(`hela-${step.serverName}`);
    if (!tools) {
      warnings.push(`Tool '${step.toolName}' could not be verified: server '${step.serverName}' was not discovered`);
      continue;
    }
    if (!tools.has(step.toolName)) {
      errors.push(`Tool '${step.toolName}' is not available in server '${step.serverName}'`);
    }
  }

  return { errors, warnings };
}
