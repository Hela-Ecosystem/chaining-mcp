import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { toolResultError } from '../agent/execution-result.js';
import type { MCPTransport } from '../managers/workflow-orchestrator.js';
import { MCP_SERVER_VERSION } from '../version.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapMcpToolResult(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return result;
  if (result.structuredContent !== undefined) return result.structuredContent;

  const [item] = result.content;
  if (result.content.length !== 1 || item?.type !== 'text' || typeof item.text !== 'string') return result;
  try {
    return JSON.parse(item.text);
  } catch {
    return item.text;
  }
}

export function createRuntimeTransport(url: URL): MCPTransport {
  return async (cell, tool, args, signal) => {
    const client = new Client({ name: 'chaining-mcp', version: MCP_SERVER_VERSION });
    try {
      await client.connect(new StreamableHTTPClientTransport(url), { signal });
      const reply = await client.callTool({
        name: 'hela.pipe',
        arguments: { steps: [{ cell, tool, args }] },
      }, undefined, { signal });

      const failure = toolResultError(reply);
      if (failure) throw new Error(failure);
      const payload = unwrapMcpToolResult(reply);
      const step = isRecord(payload) && Array.isArray(payload.results) ? payload.results[0] : undefined;
      if (!isRecord(step)) throw new Error(`Runtime returned no result for '${cell}/${tool}'`);
      const stepFailure = toolResultError(step) ?? toolResultError(step.result);
      if (stepFailure) throw new Error(stepFailure);
      if (!('result' in step)) throw new Error(`Runtime returned no result for '${cell}/${tool}'`);

      return unwrapMcpToolResult(step.result);
    } finally {
      await client.close();
    }
  };
}
