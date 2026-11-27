import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { coreChainingTools } from './core-chaining-tools.js';
import { awesomeCopilotTools } from './awesome-copilot-tools.js';
import { sequentialThinkingTools } from './sequential-thinking-tools.js';
import { timeManagementTools } from './time-management-tools.js';
import { promptResourceTools } from './prompt-resource-tools.js';
import { validationAnalysisTools } from './validation-analysis-tools.js';
import { llmTools } from './llm-tools.js';
import { agentTools, workflowLifecycleTools } from './agent-tools.js';
import { skillTools } from './skill-tools.js';
import { isAgentEnabled } from '../agent/diagnostics.js';
import { isToolAllowed, orchestratorMode } from '../config/orchestrator-mode.js';

const isLlmEnabled = (process.env.CHAINING_LLM_ENABLED || 'true').toLowerCase() !== 'false';
const agentOn = isAgentEnabled();

export const allTools: Tool[] = [
  ...coreChainingTools,
  ...awesomeCopilotTools,
  ...sequentialThinkingTools,
  ...timeManagementTools,
  ...promptResourceTools,
  ...validationAnalysisTools,
  ...workflowLifecycleTools,
  ...skillTools,
  ...(isLlmEnabled ? llmTools : []),
  ...(agentOn ? agentTools : []),
];

/** Passive mode reads only the bundled instructions, so it does not offer the repository-backed modes. */
function passiveSchema(tool: Tool): Tool {
  if (tool.name !== 'load_instruction') return tool;
  const mode = tool.inputSchema.properties?.mode as Record<string, unknown> | undefined;
  return {
    ...tool,
    description: 'Load one of the bundled instructions by filename.',
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties, mode: { ...mode, enum: ['instructions'] } } },
  };
}

/** What tools/list advertises right now; passive mode narrows it to the allow-list. */
export function advertisedTools(): Tool[] {
  if (!orchestratorMode().passive) return allTools;
  // The LLM utilities follow the same live decision here as at dispatch.
  const candidates = [...allTools.filter(tool => !llmTools.includes(tool)), ...llmTools];
  return candidates.filter(tool => isToolAllowed(tool.name)).map(passiveSchema);
}

export {
  coreChainingTools,
  awesomeCopilotTools,
  sequentialThinkingTools,
  timeManagementTools,
  promptResourceTools,
  validationAnalysisTools,
  llmTools,
  agentTools,
  workflowLifecycleTools,
  skillTools,
};
