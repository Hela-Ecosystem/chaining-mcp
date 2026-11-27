/**
 * Passive mode for external DAG coordinators (chaining-mcp#30). When
 * MITOSIS_EXTERNAL_ORCHESTRATOR is non-empty, the coordinator owns scheduling,
 * retries and state, and Mitosis exposes only discovery, reference, utility and
 * guardrail tools. Read on every call so one process can never disagree with
 * itself about the mode.
 */
export interface OrchestratorMode {
  passive: boolean;
  externalOrchestrator: string | null;
}

/** Explicit allow-list: a tool added later stays hidden in passive mode until listed here. */
const PASSIVE_TOOLS: ReadonlySet<string> = new Set([
  'list_mcp_servers', 'analyze_tools',
  'get_tool_chain_analysis', 'validate_tool_chain', 'analyze_tool_chain_performance',
  'get_current_time', 'convert_time',
  'search_instructions', 'load_instruction',
  'get_prompt', 'search_prompts', 'get_resource_set', 'search_resource_sets',
  'list_skills', 'search_skills', 'get_skill',
]);
const PASSIVE_LLM_TOOLS: ReadonlySet<string> = new Set(['llm_query', 'llm_summarize']);

export function orchestratorMode(env: NodeJS.ProcessEnv = process.env): OrchestratorMode {
  const externalOrchestrator = (env.MITOSIS_EXTERNAL_ORCHESTRATOR ?? '').trim() || null;
  return { passive: externalOrchestrator !== null, externalOrchestrator };
}

export function isToolAllowed(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orchestratorMode(env).passive) return true;
  if (PASSIVE_TOOLS.has(name)) return true;
  return PASSIVE_LLM_TOOLS.has(name) && (env.CHAINING_LLM_ENABLED || 'true').toLowerCase() !== 'false';
}

/** The structured refusal for a tool omitted in passive mode, or null when the call may proceed. */
export function passiveRefusal(tool: string, env: NodeJS.ProcessEnv = process.env) {
  if (isToolAllowed(tool, env)) return null;
  const { externalOrchestrator } = orchestratorMode(env);
  return {
    ok: false as const,
    code: 'MITOSIS_PASSIVE_MODE' as const,
    mode: 'passive' as const,
    externalOrchestrator,
    tool,
    error: `${tool} is disabled while MITOSIS_EXTERNAL_ORCHESTRATOR=${externalOrchestrator}`,
  };
}
