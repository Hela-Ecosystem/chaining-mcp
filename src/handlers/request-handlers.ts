import { checkToolAvailability, indexToolsByServer } from '../core/tool-availability.js';
import { orchestratorMode, passiveRefusal } from '../config/orchestrator-mode.js';
import { spawn } from 'child_process';
import { MCPServerDiscovery } from '../core/discovery.js';
import { SmartRouteOptimizer } from '../core/optimizer.js';
import { TimeManager } from '../managers/time-manager.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { AwesomeCopilotIntegration, LOCAL_FALLBACK_NOTICE } from '../integrations/awesome-copilot-integration.js';
import { WorkflowOrchestrator } from '../managers/workflow-orchestrator.js';
import { LLMManager } from '../managers/llm-manager.js';
import { runAgentWorkflow } from '../agent/workflow.js';
import { isAgentEnabled, escalationProviderAvailable, detectedEscalationProvider } from '../agent/diagnostics.js';
import { buildGuidance, buildSkillGuidance } from '../agent/guidance.js';
import { sharedSkills, type SkillDetail } from '../skills/skill-discovery.js';
import { MCP_SERVER_VERSION } from '../version.js';
import { currentTimeTools } from '../agent/capability-graph.js';
import { timeManagementTools } from '../tools/time-management-tools.js';
import { ToolInfo, WorkflowOrchestratorSchema } from '../types.js';

interface AnalysisStep {
  id: string;
  serverName: string;
  toolName: string;
  parameters: Record<string, unknown>;
  dependsOn?: string[];
  outputMapping?: Record<string, string>;
  retryOnFailure?: boolean;
}

/**
 * Keep the skill body (content plus file list) inside maxChars so a skill with
 * hundreds of files cannot return a 59 KB list (chaining-mcp#26). The
 * description is metadata and is not charged to the budget (chaining-mcp#28).
 */
function boundSkillResponse(detail: SkillDetail, file: string, maxChars: number) {
  const build = (content: string, files: string[], droppedReason?: string) => ({
    ok: true as const,
    // Ecosystem contract: a lossy answer says so in its shape, not only in prose.
    ...(droppedReason ? { status: 'degraded' as const, degraded: { reason: droppedReason } } : {}),
    name: detail.name,
    description: detail.description,
    file,
    files,
    ...(files.length < detail.files.length ? { filesOmitted: detail.files.length - files.length } : {}),
    content,
  });

  // The budget covers the body (content + file list); the description is
  // metadata and never crowds the body out (chaining-mcp#28).
  let content = detail.content;
  const listed = JSON.stringify(detail.files).length;
  if (content.length + listed <= maxChars) return build(content, detail.files);

  // File list first: it is the part that grows without bound.
  const omitted = detail.files.length;
  if (content.length <= maxChars) {
    return build(content, [], `file list omitted to respect maxChars (${omitted} files)`);
  }
  const suffix = '\n…[truncated]';
  content = content.slice(0, Math.max(0, maxChars - suffix.length)) + suffix;
  return build(content, [], `content truncated and ${omitted} file paths omitted to respect maxChars`);
}

export class RequestHandlers {
  constructor(
    private discovery: MCPServerDiscovery,
    private optimizer: SmartRouteOptimizer,
    private timeManager: TimeManager,
    private promptRegistry: PromptRegistry,
    private awesomeCopilotIntegration: AwesomeCopilotIntegration,
    private workflowOrchestrator: WorkflowOrchestrator,
    private llmManager?: LLMManager
  ) {}

  async handleToolCall(name: string, args: any, signal?: AbortSignal): Promise<any> {
    const refusal = passiveRefusal(name);
    if (refusal) return refusal;
    const defaultMs = parseInt(process.env.CHAINING_TOOL_TIMEOUT_MS || '10000', 10);
    // Model-backed tools carry their own budget (planning + multi-turn
    // inference + engine cold-start routinely exceed the interactive 10s).
    const modelBacked = name === 'agent_run' || name === 'brainstorming' ||
      name === 'analyze_with_sequential_thinking' || name === 'suggest_skill_chain' ||
      name === 'llm_suggest_route' || name === 'generate_route_suggestions' || name === 'llm_decompose_task' ||
      (name === 'sequentialthinking' && isAgentEnabled());
    const timeoutMs = modelBacked
      ? Math.min(Number(args?.maxExecutionMs) || 90000, 300000)
      : defaultMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      signal?.throwIfAborted();
      if (name === 'workflow_orchestrator') {
        return await this.handleSequentialThinkingTool(name, args, signal, defaultMs);
      }
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Tool '${name}' execution timed out after ${timeoutMs}ms`)), timeoutMs);
        onAbort = () => reject(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([
        this.executeTool(name, args || {}),
        timeoutPromise
      ]);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        tool: name,
      };
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  private async executeTool(name: string, args: any): Promise<any> {
    // Core Chaining Tools
    if (['list_mcp_servers', 'analyze_tools', 'generate_route_suggestions', 'analyze_with_sequential_thinking', 'get_tool_chain_analysis', 'sequentialthinking'].includes(name)) {
      return await this.handleCoreChainingTool(name, args);
    }

    // Route Awesome Copilot Tools
    if (['search_instructions', 'load_instruction'].includes(name)) {
      return await this.handleAwesomeCopilotTool(name, args);
    }

    // Sequential Thinking Tools
    if (name === 'brainstorming') {
      return await this.handleSequentialThinkingTool(name, args);
    }

    // Time Management Tools
    if (['get_current_time', 'convert_time'].includes(name)) {
      return await this.handleTimeManagementTool(name, args);
    }

    // Agent Runtime Tools (Milestone 8)
    if (['agent_run', 'workflow_status', 'workflow_cancel'].includes(name)) {
      return await this.handleAgentTool(name, args);
    }

    // Skills Management Tools
    if (['list_skills', 'search_skills', 'get_skill', 'suggest_skill_chain'].includes(name)) {
      return await this.handleSkillTool(name, args);
    }

    // Prompt & Resource Tools
    if (['get_prompt', 'search_prompts', 'get_resource_set', 'search_resource_sets'].includes(name)) {
      return await this.handlePromptResourceTool(name, args);
    }

    // Validation & Analysis Tools
    if (['validate_tool_chain', 'analyze_tool_chain_performance'].includes(name)) {
      return await this.handleValidationAnalysisTool(name, args);
    }

    // Built-in LLM Tools
    if (['llm_query', 'llm_decompose_task', 'llm_suggest_route', 'llm_summarize'].includes(name)) {
      return await this.handleLLMTool(name, args);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  private async handleLLMTool(name: string, args: any): Promise<any> {
    // No blanket llmManager guard: Needle-backed cases (decompose/suggest
    // when the agent is on) must work without an LLM manager instance.
    const needLLM = () => {
      if (!this.llmManager) return { ok: false, error: 'LLM manager not initialized', tool: name };
      return null;
    };

    switch (name) {
      case 'llm_query': {
        const guard = needLLM();
        if (guard) return guard;
        return await this.llmManager!.query(args.prompt, args.systemPrompt);
      }

      case 'llm_decompose_task': {
        const tools = this.discovery.getTools();
        const summary = tools.map(t => `${t.name} (${t.category || 'utility'}): ${t.description}`).join('\n');
        // Needle-first planning; honest failure when no provider can plan (M7: no fake plans).
        if (isAgentEnabled()) {
          try {
            const { planTask } = await import('../agent/agent.js');
            const plan = await planTask(
              args.task, summary, undefined, undefined,
              this.agentToolDecls(),
              this.resolveGuidance(String(args.task || '')),
            );
            return {
              ok: true,
              ...this.planFields(plan),
              subtasks: plan.steps.map(s => ({
                step: s.step,
                task: s.task,
                recommendedCategory: s.recommendedCategory || 'utility',
                tool: s.tool,
                dependsOn: s.dependsOn,
              })),
            };
          } catch (e) {
            return this.plannerFailure(e);
          }
        }
        const guard = needLLM();
        if (guard) return guard;
        return await this.llmManager!.decomposeTask(args.task, summary);
      }

      case 'llm_suggest_route': {
        // M7: route suggestion IS Needle planning — no heuristic route list.
        // The validated plan becomes the single suggested route.
        try {
          const { planTask } = await import('../agent/agent.js');
          const plan = await planTask(
            String(args.task || ''), '',
            undefined, undefined,
            this.agentToolDecls(),
            this.resolveGuidance(String(args.task || '')),
          );
          const resolved = this.resolvePlanTools(plan.steps);
          const planTools = [...resolved.values()];
          const unresolved = plan.steps.length - planTools.length;
          return {
            ok: true,
            ...this.planFields(plan),
            routes: [{
              id: `plan_route_${Date.now()}`,
              name: `${plan.source} plan`,
              description: `${plan.steps.length}-step chain for: ${String(args.task || '').slice(0, 120)}${unresolved ? ` (${unresolved} step(s) without a registry tool)` : ''}`,
              tools: planTools,
              estimatedDuration: planTools.reduce((sum, t: any) => sum + (t.estimatedDuration || 500), 0),
              complexity: Math.round(plan.steps.length * 10) / 10,
              confidence: plan.steps.length ? Math.round((planTools.length / plan.steps.length) * 100) / 100 : 0,
              reasoning: `${plan.source} selected ${plan.steps.length} step(s); ${planTools.length} resolved against the registry`,
            }],
          };
        } catch (e) {
          return this.plannerFailure(e);
        }
      }

      case 'llm_summarize': {
        const guard = needLLM();
        if (guard) return guard;
        const summary = await this.llmManager!.summarize(args.content, args.maxWords);
        return { ok: true, summary };
      }

      default:
        throw new Error(`Unknown LLM tool: ${name}`);
    }
  }

  /** Tool declarations (with exact arg schemas and cell) for Needle context. */
  private agentToolDecls(): Array<{ name: string; description?: string; schema?: unknown; server?: string }> {
    return this.discovery.getTools().map(t => ({
      name: t.name,
      description: t.description,
      schema: (t.inputSchema as any)?.properties ? t.inputSchema : undefined,
      server: t.serverName ?? (t as { server?: string }).server,
    }));
  }

  /**
   * Planned steps name a tool by its cell-prefixed address (`hela_membrane_read_file`).
   * Resolve that back to the discovered entry, accepting the bare name too.
   */
  private resolvePlanTools(steps: Array<{ tool: string }>): Map<string, any> {
    const byName = new Map<string, any>();
    for (const tool of this.discovery.getTools()) {
      byName.set(tool.name, tool);
      const server = tool.serverName ?? (tool as { server?: string }).server;
      if (server) byName.set(`${String(server).replace(/-/g, '_')}_${tool.name}`, tool);
    }
    const resolved = new Map<string, any>();
    for (const step of steps) {
      const tool = byName.get(step.tool);
      if (tool) resolved.set(step.tool, tool);
    }
    return resolved;
  }

  /** Planner provenance: a fallback or a shortfall makes the result degraded, never silently equal. */
  private planFields(plan: { source: string; plannerError?: string; omittedSteps?: number }): Record<string, unknown> {
    return {
      source: plan.source,
      degraded: plan.source !== 'needle' || Boolean(plan.plannerError) || Boolean(plan.omittedSteps),
      ...(plan.plannerError ? { plannerError: plan.plannerError } : {}),
      ...(plan.omittedSteps ? { omittedSteps: plan.omittedSteps } : {}),
    };
  }

  private plannerFailure(error: unknown): Record<string, unknown> {
    const plannerError = error && typeof error === 'object' && 'plannerError' in error
      && typeof (error as { plannerError?: unknown }).plannerError === 'string'
      ? (error as { plannerError: string }).plannerError
      : undefined;
    return {
      ok: false,
      source: 'planner',
      error: error instanceof Error ? error.message : String(error),
      ...(plannerError ? { plannerError } : {}),
    };
  }

  /** Task-relevant prebuilt-prompt + skill guidance for agent context (local, capped). */
  private resolveGuidance(task: string): string {
    const parts: string[] = [];
    try {
      const prompts = buildGuidance(this.promptRegistry, task, this.discovery.getTools().flatMap((t) => {
        // Prompts name tools by cell-prefixed address; discovery lists bare names.
        const server = t.serverName ?? (t as { server?: string }).server;
        return server ? [t.name, `${String(server).replace(/-/g, '_')}_${t.name}`] : [t.name];
      }));
      if (prompts) parts.push(prompts);
    } catch { /* guidance never breaks the run */ }
    try {
      const skills = buildSkillGuidance(sharedSkills(), task);
      if (skills) parts.push(`Relevant skills:\n${skills}`);
    } catch { /* guidance never breaks the run */ }
    return parts.join('\n');
  }

  private async handleCoreChainingTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'list_mcp_servers':
        const servers = this.discovery.getServers();
        return {
          servers: servers.map(s => ({
            name: s.name,
            command: s.command,
            args: s.args,
            capabilities: s.capabilities,
          })),
          total: servers.length,
        };

      case 'analyze_tools': {
        const tools = this.discovery.getTools();
        const filtered = args.serverName
          ? tools.filter(t => t.serverName === args.serverName)
          : args.category
            ? tools.filter(t => t.serverName === args.category)
            : tools;

        return {
          tools: filtered.map(t => ({
            name: t.name,
            description: t.description,
            server: t.serverName,
            category: t.serverName,
            complexity: t.discoverySource === 'fallback' ? null : t.estimatedComplexity ?? null,
          })),
          total: filtered.length,
          categories: [...new Set(filtered.map(t => t.serverName))],
        };
      }

      case 'generate_route_suggestions': {
        // M7: heuristic route ranking removed — suggestions come from the
        // Needle planner (single validated route). The optimizer remains for
        // deterministic validation/analysis of caller-supplied chains only.
        try {
          const { planTask } = await import('../agent/agent.js');
          const plan = await planTask(
            String(args.task || ''), '',
            undefined, undefined,
            this.agentToolDecls(),
            this.resolveGuidance(String(args.task || '')),
          );
          const resolved = this.resolvePlanTools(plan.steps);
          const planTools = [...resolved.values()];
          return {
            ok: true,
            ...this.planFields(plan),
            routes: [{
              tools: [...resolved.keys()],
              estimatedDuration: planTools.reduce((sum, t: any) => sum + (t.estimatedDuration || 500), 0),
              complexity: Math.round(plan.steps.length * 10) / 10,
              confidence: plan.steps.length ? Math.round((planTools.length / plan.steps.length) * 100) / 100 : 0,
              reasoning: `${plan.source} selected ${plan.steps.length} step(s); ${planTools.length} resolved against the registry`,
            }],
            totalRoutes: 1,
          };
        } catch (e) {
          return this.plannerFailure(e);
        }
      }

      case 'analyze_with_sequential_thinking': {
        const availableTools = this.discovery.getTools();
        // Needle-backed: the plan IS the sequential analysis — one validated
        // tool chain instead of canned template thoughts. No remote MCP and
        // no heuristic fallback here; planTask throws honestly when neither
        // Needle nor OpenRouter can plan.
        const { planTask } = await import('../agent/agent.js');
        try {
          const plan = await planTask(
            String(args.problem || ''), '',
            undefined, undefined,
            this.agentToolDecls(),
            this.resolveGuidance(String(args.problem || '')),
          );
          const planTools = [...this.resolvePlanTools(plan.steps).values()];
          const knownShare = plan.steps.length ? planTools.length / plan.steps.length : 0;
          return {
            ok: true,
            ...this.planFields(plan),
            thoughts: plan.steps.map(s => ({
              number: s.step,
              content: `${s.tool}: ${s.task}`,
              type: 'planning',
            })),
            analysis: {
              problemComplexity: plan.steps.length > 4 ? 'high' : plan.steps.length > 2 ? 'medium' : 'low',
              toolAvailability: availableTools.length,
              recommendedApproach: plan.steps.length <= 2 ? 'simple' : 'comprehensive',
              keyInsights: plan.steps.map(s => `${s.tool} — ${s.task}`),
              potentialChallenges: [],
            },
            suggestions: [{
              id: `plan_${Date.now()}`,
              name: `${plan.source} plan`,
              description: `${plan.steps.length}-step tool chain for: ${String(args.problem || '').slice(0, 120)}`,
              tools: planTools,
              estimatedDuration: planTools.reduce((sum, t: any) => sum + (t.estimatedDuration || 500), 0),
              complexity: Math.round(plan.steps.length * 10) / 10,
              confidence: Math.round(knownShare * 100) / 100,
              reasoning: `${planTools.length}/${plan.steps.length} planned tools resolved against the discovery registry`,
            }],
            confidence: Math.round(knownShare * 100) / 100,
            reasoning: `${plan.source} produced ${plan.steps.length} step(s); reasoning cites registry tools only.`,
          };
        } catch (e) {
          return this.plannerFailure(e);
        }
      }

      case 'get_tool_chain_analysis':
        return this.optimizer.getToolChainAnalysis(String(args.input ?? ''), this.discovery.getTools());

      case 'sequentialthinking': {
        // Needle-backed sequential thinking: a thought becomes one
        // observe → decide (→ optionally execute) agent step recorded in
        // AgentState. No remote sequentialthinking MCP, no caller-supplied
        // thought storage — the model reasons, the state remembers.
        const { agentStep } = await import('../agent/agent.js');
        const { sharedAgentState } = await import('../agent/state.js');
        const tools = this.discovery.getTools();
        const taskText = String(args.task || args.thought || '');
        const step = await agentStep({
            task: taskText,
            observation: args.thought ? String(args.thought) : undefined,
            sessionId: args.sessionId ? String(args.sessionId) : undefined,
            tools: tools.map(t => ({ name: t.name, description: t.description, schema: (t.inputSchema as any)?.properties ? t.inputSchema : undefined })),
            execute: args.execute !== false,
            executor: {
              executeTool: (tool, params, signal) => this.workflowOrchestrator.executeTool(tool, (params as Record<string, any>) || {}, { signal }),
            },
            revision: args.isRevision ? `revises thought ${args.revisesThought || '?'}` : undefined,
            branch: args.branchId ? { branchId: String(args.branchId), fromEvent: args.branchFromThought } : undefined,
            guidance: this.resolveGuidance(taskText),
            state: sharedAgentState(),
          });
          const n = Number(args.thoughtNumber) || (step.stats?.events ?? 1);
          const total = Number(args.totalThoughts) || n;
          return {
            // Legacy-shaped fields (compat): thought numbering now mirrors state.
            thoughtNumber: n,
            totalThoughts: Math.max(total, n),
            nextThoughtNeeded: step.decision.action === 'call_tool' || step.decision.action === 'revise',
            // Agent-shaped fields.
            source: 'needle-agent',
            sessionId: step.sessionId,
            decision: step.decision,
            result: step.result,
            error: step.error,
            escalated: step.escalated,
            handoff: step.handoff,
            escalation: {
              configured: escalationProviderAvailable(),
              provider: detectedEscalationProvider(),
            },
            state: step.stats,
            recentState: step.tail,
          };
      }

      default:
        throw new Error(`Unknown core chaining tool: ${name}`);
    }
  }

  private async handleAwesomeCopilotTool(name: string, args: any): Promise<any> {
    const awesomeCopilotServer = this.discovery.getServers().find(server => server.name === 'awesome-copilot');
    const githubToken = awesomeCopilotServer?.env?.GITHUB__TOKEN || process.env.GITHUB_TOKEN || process.env.GITHUB__TOKEN;

    // If external server and token are configured, attempt remote call first (never in passive mode: it launches a process)
    if (!orchestratorMode().passive && awesomeCopilotServer && githubToken && githubToken !== 'your_github_token_here') {
      try {
        const result = await this.executeAwesomeCopilotTool(awesomeCopilotServer, name, args);
        if (result && !result.error) {
          return result;
        }
      } catch (error) {
        // Fall back to local integration on error
      }
    }

    // Graceful local fallback. It is always degraded: two bundled heading
    // outlines are not the awesome-copilot repository, whether or not a token
    // is set (chaining-mcp#27).
    const fallback = (extra: Record<string, unknown> = {}) => ({
      source: 'local_fallback' as const,
      status: 'degraded' as const,
      warning: LOCAL_FALLBACK_NOTICE,
      degraded: {
        reason: LOCAL_FALLBACK_NOTICE,
        ...(githubToken ? {} : { hint: 'set GITHUB_TOKEN and configure the awesome-copilot MCP server' }),
      },
      ...extra,
    });

    if (name === 'search_instructions') {
      const keywords = String(args.keywords || '');
      const results = this.awesomeCopilotIntegration.searchInstructions(keywords);
      return fallback({ results, total: results.length });
    }

    if (name === 'load_instruction') {
      const mode = String(args.mode || 'instructions');
      const filename = String(args.filename || '');
      const instruction = this.awesomeCopilotIntegration.getInstruction(mode, filename);
      if (instruction) {
        return fallback({ ...instruction });
      }
      return fallback({
        error: `Instruction not found: ${mode}/${filename}`,
        available: this.awesomeCopilotIntegration.getInstructions().map(i => `${i.mode}/${i.filename}`),
      });
    }

    throw new Error(`Unknown awesome copilot tool: ${name}`);
  }

  private async executeAwesomeCopilotTool(serverInfo: any, toolName: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let child: any = null;
      const timeout = setTimeout(() => {
        if (child) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
        reject(new Error(`Timeout executing tool ${toolName} on awesome-copilot server`));
      }, 3000); // 3 second timeout

      try {
        child = spawn(serverInfo.command, serverInfo.args, {
          env: { ...process.env, ...serverInfo.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let errorOutput = '';

        child.stdout?.on('data', (data: Buffer) => {
          output += data.toString();
        });

        child.stderr?.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });

        child.on('error', (error: Error) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn awesome-copilot server: ${error.message}`));
        });

        child.on('close', (code: number) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Awesome-copilot server exited with code ${code}: ${errorOutput}`));
            return;
          }

          try {
            // Parse the MCP response
            const response = this.parseAwesomeCopilotResponse(output);
            if (response && response.result && response.result.content) {
              const content = response.result.content[0];
              if (content && content.type === 'text') {
                const result = JSON.parse(content.text);
                resolve(result);
              } else {
                resolve(response.result);
              }
            } else {
              resolve({ message: 'Tool executed successfully but no result returned' });
            }
          } catch (parseError) {
            reject(new Error(`Failed to parse response from awesome-copilot server: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
          }
        });

        // Send MCP initialize request first
        const initRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'chaining-mcp-server', version: MCP_SERVER_VERSION }
          }
        };

        child.stdin?.write(JSON.stringify(initRequest) + '\n');

        setTimeout(() => {
          const toolRequest = {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: toolName,
              arguments: args
            }
          };

          child.stdin?.write(JSON.stringify(toolRequest) + '\n');
          child.stdin?.end();
        }, 500);

      } catch (error) {
        clearTimeout(timeout);
        if (child) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
        reject(new Error(`Failed to execute tool on awesome-copilot server: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private parseAwesomeCopilotResponse(output: string): any {
    const lines = output.split('\n').filter(line => line.trim());
    for (const line of lines) {
      try {
        const response = JSON.parse(line);
        if (response.id === 2 && response.result) { // Our tool call response
          return response;
        }
      } catch (error) {
        // Skip invalid JSON lines
        continue;
      }
    }
    return null;
  }

  private normalizeToolChain(toolChain: any[], availableTools: ToolInfo[]): AnalysisStep[] {
    if (!Array.isArray(toolChain)) return [];
    return toolChain.map((step, index) => {
      if (typeof step === 'string') {
        const found = availableTools.find(t => t.name === step);
        return {
          id: `step_${index + 1}`,
          serverName: found?.serverName ?? 'core',
          toolName: step,
          parameters: {},
        };
      }
      const toolName = step?.toolName || step?.name || `tool_${index + 1}`;
      return {
        ...step,
        id: step?.id || `step_${index + 1}`,
        serverName: step?.serverName || availableTools.find(t => t.name === toolName)?.serverName || 'core',
        toolName,
        parameters: step?.parameters || {},
      };
    });
  }

  private validateToolChain(
    rawToolChain: any[],
    availableTools: ToolInfo[],
    options: {
      checkCircularDependencies?: boolean;
      checkToolAvailability?: boolean;
      checkParameterCompatibility?: boolean;
    } = {}
  ): {
    valid: boolean;
    errors: string[];
    warnings: string[];
    normalizedToolChain?: any[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!Array.isArray(rawToolChain) || rawToolChain.length === 0) {
      return {
        valid: false,
        errors: ['Tool chain must be a non-empty array'],
        warnings: [],
      };
    }

    const toolChain = this.normalizeToolChain(rawToolChain, availableTools);

    // Check circular dependencies if requested
    if (options.checkCircularDependencies !== false) {
      const circularErrors = this.checkCircularDependencies(toolChain);
      errors.push(...circularErrors);
    }

    // Check tool availability if requested
    if (options.checkToolAvailability !== false) {
      const availability = checkToolAvailability(toolChain, availableTools);
      errors.push(...availability.errors);
      warnings.push(...availability.warnings);
    }

    // Check parameter compatibility if requested
    if (options.checkParameterCompatibility !== false) {
      const compatibilityWarnings = this.checkParameterCompatibility(toolChain);
      warnings.push(...compatibilityWarnings);
    }

    // Additional validation checks
    const generalErrors = this.checkGeneralValidation(toolChain);
    errors.push(...generalErrors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      normalizedToolChain: toolChain,
    };
  }

  private checkCircularDependencies(toolChain: any[]): string[] {
    const errors: string[] = [];
    const dependencyGraph: Record<string, string[]> = {};

    // Build dependency graph
    toolChain.forEach(step => {
      if (step.dependsOn && Array.isArray(step.dependsOn)) {
        dependencyGraph[step.id] = step.dependsOn;
      } else {
        dependencyGraph[step.id] = [];
      }
    });

    // Check for cycles using DFS
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (nodeId: string): boolean => {
      if (recursionStack.has(nodeId)) {
        return true; // Cycle detected
      }
      if (visited.has(nodeId)) {
        return false; // Already processed
      }

      visited.add(nodeId);
      recursionStack.add(nodeId);

      const dependencies = dependencyGraph[nodeId] || [];
      for (const dep of dependencies) {
        if (hasCycle(dep)) {
          errors.push(`Circular dependency detected: ${nodeId} -> ${dep}`);
          return true;
        }
      }

      recursionStack.delete(nodeId);
      return false;
    };

    // Check all nodes for cycles
    Object.keys(dependencyGraph).forEach(nodeId => {
      if (!visited.has(nodeId)) {
        hasCycle(nodeId);
      }
    });

    return errors;
  }

  private checkParameterCompatibility(toolChain: any[]): string[] {
    const warnings: string[] = [];

    toolChain.forEach((step, index) => {
      const params = step.parameters || {};

      // Check for common parameter compatibility issues
      if (typeof params !== 'object') {
        warnings.push(`Step ${step.id}: parameters should be an object`);
      }

      // Check for output mapping compatibility
      if (step.outputMapping) {
        Object.entries(step.outputMapping).forEach(([paramName, mapping]) => {
          const [sourceStepId] = (mapping as string).split('.');
          const sourceStep = toolChain.find(s => s.id === sourceStepId);

          if (!sourceStep) {
            warnings.push(`Step ${step.id}: output mapping references non-existent step '${sourceStepId}'`);
          }
        });
      }

      // Check dependency satisfaction
      if (step.dependsOn && Array.isArray(step.dependsOn)) {
        step.dependsOn.forEach((depId: string) => {
          const depStep = toolChain.find(s => s.id === depId);
          if (!depStep) {
            warnings.push(`Step ${step.id}: depends on non-existent step '${depId}'`);
          }
        });
      }
    });

    return warnings;
  }

  private checkGeneralValidation(toolChain: any[]): string[] {
    const errors: string[] = [];

    if (!Array.isArray(toolChain)) {
      errors.push('Tool chain must be an array');
      return errors;
    }

    if (toolChain.length === 0) {
      errors.push('Tool chain cannot be empty');
      return errors;
    }

    const stepIds = new Set<string>();

    toolChain.forEach((step, index) => {
      const stepId = step.id || `step_${index + 1}`;
      if (stepIds.has(stepId)) {
        errors.push(`Step ${stepId}: duplicate step ID`);
      }
      stepIds.add(stepId);

      if (!step.toolName && !step.name) {
        errors.push(`Step ${stepId}: missing required field 'toolName'`);
      }

      // Check retry configuration
      if (step.retryOnFailure && (step.maxRetries === undefined || step.maxRetries < 0)) {
        errors.push(`Step ${stepId}: retryOnFailure is true but maxRetries is not set or invalid`);
      }
    });

    return errors;
  }

  private async handleSequentialThinkingTool(name: string, args: any, signal?: AbortSignal, defaultTimeout?: number): Promise<any> {
    switch (name) {
      case 'brainstorming': {
        // M7: template ideas + random scores deleted. Ideation needs a
        // generative model — OpenRouter provides it, otherwise honest failure.
        // (Needle is a tool-calling router, not a text generator.)
        if (!this.llmManager?.isEnabled()) {
          return {
            ok: false, source: 'none',
            error: 'brainstorming needs a generative model (set CHAINING_LLM_ENABLED=true with OPENROUTER_API_KEY); template ideas with random scores were removed in M7',
            tool: name,
          };
        }
        const count = Math.min(Math.max(Number(args.ideaCount) || 8, 1), 20);
        const buildPrompt = (c: number, forceShort: boolean) => {
          const short = forceShort ? 'Keep every idea under 20 words.' : '';
          return `Brainstorm ${c} distinct ideas about: "${args.topic || ''}".` +
            (args.context ? ` Context: ${args.context}.` : '') +
            ` Approach: ${args.approach || 'creative'}.` +
            (args.constraints?.length ? ` Constraints: ${args.constraints.join('; ')}.` : '') +
            ` ${short}\nRespond strictly as a JSON array: [{"content":"...","category":"...","pros":["..."],"cons":["..."]}]`;
        };
        const parseIdeas = (raw: string): any[] | null => {
          const start = raw.indexOf('[');
          const end = raw.lastIndexOf(']');
          if (start < 0 || end <= start) return null;
          try {
            const arr = JSON.parse(raw.slice(start, end + 1));
            return Array.isArray(arr) && arr.length ? arr : null;
          } catch {
            return null;
          }
        };
        let result = await this.llmManager.query(buildPrompt(count, false), 'You are a creative ideation engine. Output valid JSON only, no fences.');
        let ideas = result.ok && result.text ? parseIdeas(result.text) : null;
        if (!ideas) {
          // Truncated/free-model noise: retry once, shorter.
          result = await this.llmManager.query(buildPrompt(Math.max(3, count), true), 'You are a creative ideation engine. Output a compact JSON array only.');
          ideas = result.ok && result.text ? parseIdeas(result.text) : null;
        }
        if (!ideas) {
          return { ok: false, source: 'openrouter', error: 'ideation output unparseable after retry' };
        }
        return {
          ok: true, source: 'openrouter',
          topic: args.topic, approach: args.approach || 'creative',
          ideas: ideas.slice(0, count).map((idea: any, i: number) => ({
            id: `idea-${Date.now()}-${i}`,
            content: String(idea.content || ''),
            category: String(idea.category || args.approach || 'creative'),
            pros: Array.isArray(idea.pros) ? idea.pros.map(String) : [],
            cons: Array.isArray(idea.cons) ? idea.cons.map(String) : [],
          })),
          timestamp: new Date().toISOString(),
        };
      }

      case 'workflow_orchestrator': {
        const workflow = WorkflowOrchestratorSchema.parse(args);
        const workflowResult = await this.workflowOrchestrator.executeWorkflow({
          ...workflow,
          timeout: workflow.timeout ?? defaultTimeout,
        }, signal);
        return {
          workflowId: workflowResult.workflowId,
          status: workflowResult.status,
          steps: workflowResult.steps.map(step => ({
            stepId: step.stepId,
            status: step.status,
            serverName: step.serverName,
            toolName: step.toolName,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
            executionTime: step.executionTime,
            result: step.result,
            error: step.error,
            retryCount: step.retryCount,
            dependencies: step.dependencies,
          })),
          overallResult: workflowResult.overallResult,
          executionTime: workflowResult.executionTime,
          startedAt: workflowResult.startedAt,
          completedAt: workflowResult.completedAt,
          error: workflowResult.error,
        };
      }

      default:
        throw new Error(`Unknown sequential thinking tool: ${name}`);
    }
  }

  private async handleSkillTool(name: string, args: any): Promise<any> {
    const catalog = sharedSkills();
    switch (name) {
      case 'list_skills': {
        const skills = catalog.scan();
        return {
          ok: true,
          total: skills.length,
          skills: skills.map(s => ({ name: s.name, description: s.description, files: s.files.length, bodyChars: s.bodyChars })),
        };
      }

      case 'search_skills': {
        const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
        const matches = catalog.search(String(args.query || '')).slice(0, limit);
        return {
          ok: true, total: matches.length,
          skills: matches.map(s => ({ name: s.name, description: s.description, files: s.files.length })),
        };
      }

      case 'get_skill': {
        const file = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : 'SKILL.md';
        const name = String(args.name || '');
        const found = catalog.lookup(name, undefined, file);
        if (!found.ok) {
          if (found.reason === 'path_not_allowed') {
            return { ok: false, error: `path not allowed: '${file}'` };
          }
          if (found.reason === 'file_not_in_skill') {
            return {
              ok: false,
              error: `file not in skill '${name}': '${file}' (available: ${(found.available ?? []).slice(0, 50).join(', ')})`,
              available: (found.available ?? []).slice(0, 50),
            };
          }
          // A SKILL.md that failed to parse is not the same as a missing skill.
          const failures = catalog.parseFailures();
          return {
            ok: false,
            error: `unknown skill '${name}'`,
            ...(failures.length ? { parseFailures: failures.slice(0, 5) } : {}),
          };
        }
        const detail = found.detail as SkillDetail;
        const maxChars = Math.min(Math.max(Number(args.maxChars) || 8000, 500), 60000);
        return boundSkillResponse(detail, file, maxChars);
      }

      case 'suggest_skill_chain': {
        // Needle plans over registry tools; skill recommendations attach per
        // step via deterministic catalog match (labeled skillHints, not model output).
        try {
          const { planTask } = await import('../agent/agent.js');
          const taskText = String(args.task || '');
          const plan = await planTask(
            taskText, '', undefined, undefined,
            this.agentToolDecls(),
            this.resolveGuidance(taskText),
          );
          return {
            ok: true,
            ...this.planFields(plan),
            steps: plan.steps.map(s => ({
              step: s.step, task: s.task, tool: s.tool, dependsOn: s.dependsOn,
              skillHints: catalog.search(`${s.task} ${s.tool || ''}`).slice(0, 2).map(x => x.name),
            })),
          };
        } catch (e) {
          return this.plannerFailure(e);
        }
      }

      default:
        throw new Error(`Unknown skill tool: ${name}`);
    }
  }

  private async handleAgentTool(name: string, args: any): Promise<any> {    switch (name) {
      case 'workflow_status': {
        const status = this.workflowOrchestrator.getWorkflowStatus(String(args.workflowId || ''));
        if (!status) return { ok: false, error: `unknown workflow '${args.workflowId}'` };
        return { ok: true, ...status };
      }

      case 'workflow_cancel': {
        const cancelled = this.workflowOrchestrator.cancelWorkflow(String(args.workflowId || ''));
        return cancelled
          ? { ok: true, workflowId: args.workflowId, status: 'cancelled' }
          : { ok: false, error: `workflow '${args.workflowId}' is not running or unknown` };
      }

      case 'agent_run': {
        if (!isAgentEnabled()) {
          return { ok: false, error: 'agent runtime disabled (engine missing and MITOSIS_AGENT_ENABLED not set; run npm run needle:fetch or set MITOSIS_AGENT_ENABLED=true)', tool: name };
        }
        const taskText = String(args.task || '');
        const toolSchemas = this.agentToolDecls();
        if (currentTimeTools(toolSchemas, taskText)?.length === 0) {
          const clock = timeManagementTools.find(t => t.name === 'get_current_time');
          if (clock) toolSchemas.push({ name: clock.name, description: clock.description, schema: clock.inputSchema });
        }
        const { plan, workflowId, run, state } = await runAgentWorkflow({
          task: taskText,
          toolSchemas,
          orchestrator: this.workflowOrchestrator,
          guidance: this.resolveGuidance(taskText),
          limits: {
            maxIterations: args.maxIterations || 8,
            maxToolCalls: args.maxToolCalls || 12,
            maxExecutionMs: args.maxExecutionMs || 60000,
          },
        });
        const sessionId = run.sessionId || '';
        return {
          ok: run.decision.action === 'complete',
          ...(run.decision.action === 'escalate' ? { error: run.decision.reason } : {}),
          workflowId,
          sessionId,
          plan: plan.steps,
          decision: run.decision,
          toolCalls: run.toolCalls,
          iterations: run.iterations,
          escalated: run.escalated,
          handoff: run.handoff,
          escalation: {
            configured: escalationProviderAvailable(),
            provider: detectedEscalationProvider(),
          },
          escalations: run.escalations,
          stateStats: sessionId ? state.stats(sessionId) : undefined,
        };
      }

      default:
        throw new Error(`Unknown agent tool: ${name}`);
    }
  }

  private async handleTimeManagementTool(name: string, args: any): Promise<any> {    switch (name) {
      case 'get_current_time': {
        const timezone = String(args.timezone || 'UTC');
        const timeResult = this.timeManager.getCurrentTime(timezone);
        return {
          timezone: timeResult.timezone,
          datetime: timeResult.datetime,
          is_dst: timeResult.is_dst,
          day_of_week: timeResult.day_of_week,
        };
      }

      case 'convert_time': {
        const sourceTimezone = String(args.source_timezone || args.sourceTimezone || 'UTC');
        const timeStr = String(args.time || args.timeStr || '12:00');
        const targetTimezone = String(args.target_timezone || args.targetTimezone || 'UTC');
        const conversion = this.timeManager.convertTime(sourceTimezone, timeStr, targetTimezone);
        return {
          source: {
            timezone: conversion.source.timezone,
            datetime: conversion.source.datetime,
            day_of_week: conversion.source.day_of_week,
            is_dst: conversion.source.is_dst,
          },
          target: {
            timezone: conversion.target.timezone,
            datetime: conversion.target.datetime,
            day_of_week: conversion.target.day_of_week,
            is_dst: conversion.target.is_dst,
          },
          time_difference: conversion.time_difference,
        };
      }

      default:
        throw new Error(`Unknown time management tool: ${name}`);
    }
  }

  private async handlePromptResourceTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'get_prompt': {
        const id = String(args.id || args.name || args.promptId || args.query || '').trim();
        const allPrompts = this.promptRegistry.getAllPrompts();
        if (!id) {
          return {
            error: 'Missing prompt id or name',
            totalAvailable: allPrompts.length,
            availablePrompts: allPrompts.slice(0, 10).map(p => ({ id: p.id, name: p.name, category: p.category })),
          };
        }
        const prompt = this.promptRegistry.getPrompt(id) ||
          allPrompts.find(p =>
            p.id.toLowerCase() === id.toLowerCase() ||
            p.name.toLowerCase() === id.toLowerCase() ||
            p.id.toLowerCase().includes(id.toLowerCase())
          );
        return prompt || {
          error: `Prompt not found: ${id}`,
          totalAvailable: allPrompts.length,
          availablePrompts: allPrompts.slice(0, 10).map(p => p.id),
        };
      }

      case 'search_prompts': {
        const rawQ = String(args.query || args.q || args.search || args.keyword || args.keywords || args.topic || args.filter || '').trim();
        const q = rawQ.toLowerCase();
        const allPrompts = this.promptRegistry.getAllPrompts();

        let filteredPrompts: any[] = [];
        if (!q) {
          filteredPrompts = allPrompts;
        } else {
          const tokens = q.split(/[\s,_\-]+/).filter(t => t.length > 1);
          filteredPrompts = allPrompts.filter(p => {
            const fullText = `${p.id} ${p.name} ${p.description} ${p.category} ${p.tags ? p.tags.join(' ') : ''} ${p.useCase || ''} ${p.prompt || ''}`.toLowerCase();
            if (fullText.includes(q)) return true;
            return tokens.some(token => fullText.includes(token) || (token.startsWith('web') && fullText.includes('web')) || (token.startsWith('app') && fullText.includes('project')));
          });
        }

        if (args.category) {
          filteredPrompts = filteredPrompts.filter(p => p.category.toLowerCase() === String(args.category).toLowerCase());
        }
        if (args.complexity) {
          filteredPrompts = filteredPrompts.filter(p => p.complexity.toLowerCase() === String(args.complexity).toLowerCase());
        }

        // A category/complexity filter that matches nothing returns nothing: never
        // substitute prompts from another category (chaining-mcp#28).
        const filtered = Boolean(args.category || args.complexity);
        const keywordMiss = Boolean(q) && !filtered && filteredPrompts.length === 0;
        const results = keywordMiss ? allPrompts.slice(0, 5) : filteredPrompts;

        return {
          prompts: results,
          total: results.length,
          query: rawQ,
          matchedDirectly: filteredPrompts.length > 0,
          ...(filtered && filteredPrompts.length === 0
            ? { note: `no prompts match${args.category ? ` category '${args.category}'` : ''}${args.complexity ? ` complexity '${args.complexity}'` : ''}${rawQ ? ` for query '${rawQ}'` : ''}` }
            : {}),
        };
      }

      case 'get_resource_set': {
        const id = String(args.id || args.name || args.resourceSetId || args.query || '').trim();
        const allSets = this.promptRegistry.getAllResourceSets();
        if (!id) {
          return {
            error: 'Missing resource set id or name',
            totalAvailable: allSets.length,
            availableResourceSets: allSets.map(rs => ({ id: rs.id, name: rs.name, category: rs.category })),
          };
        }
        const resourceSet = this.promptRegistry.getResourceSet(id) ||
          allSets.find(rs =>
            rs.id.toLowerCase() === id.toLowerCase() ||
            rs.name.toLowerCase() === id.toLowerCase() ||
            rs.id.toLowerCase().includes(id.toLowerCase())
          );
        return resourceSet || {
          error: `Resource set not found: ${id}`,
          totalAvailable: allSets.length,
          availableResourceSets: allSets.slice(0, 10).map(rs => rs.id),
        };
      }

      case 'search_resource_sets': {
        const rawQ = String(args.query || args.q || args.search || args.keyword || args.keywords || args.topic || args.filter || '').trim();
        const q = rawQ.toLowerCase();
        const allResourceSets = this.promptRegistry.getAllResourceSets();

        let filteredResourceSets: any[] = [];
        if (!q) {
          filteredResourceSets = allResourceSets;
        } else {
          const tokens = q.split(/[\s,_\-]+/).filter(t => t.length > 1);
          filteredResourceSets = allResourceSets.filter(rs => {
            const fullText = `${rs.id} ${rs.name} ${rs.description} ${rs.category} ${rs.tags ? rs.tags.join(' ') : ''}`.toLowerCase();
            if (fullText.includes(q)) return true;
            return tokens.some(token => fullText.includes(token) || (token.startsWith('web') && fullText.includes('dev')));
          });
        }

        if (args.category) {
          filteredResourceSets = filteredResourceSets.filter(rs => rs.category.toLowerCase() === String(args.category).toLowerCase());
        }
        if (args.complexity) {
          filteredResourceSets = filteredResourceSets.filter(rs => rs.complexity.toLowerCase() === String(args.complexity).toLowerCase());
        }

        const results = filteredResourceSets.length > 0 ? filteredResourceSets : allResourceSets.slice(0, 4);

        return {
          resourceSets: results,
          total: results.length,
          query: rawQ,
          matchedDirectly: filteredResourceSets.length > 0,
        };
      }

      default:
        throw new Error(`Unknown prompt/resource tool: ${name}`);
    }
  }

  private async handleValidationAnalysisTool(name: string, args: any): Promise<any> {
    switch (name) {
      case 'validate_tool_chain':
        const toolChain = args.toolChain || [];
        const availableTools = this.discovery.getTools();
        return this.validateToolChain(toolChain, availableTools, args);

      case 'analyze_tool_chain_performance': {
        const tools = this.discovery.getTools();
        const toolChain = this.normalizeToolChain(args.toolChain, tools);
        return this.analyzeToolChainPerformance(toolChain, tools, args);
      }

      default:
        throw new Error(`Unknown validation/analysis tool: ${name}`);
    }
  }

  private analyzeToolChainPerformance(
    toolChain: AnalysisStep[],
    tools: ToolInfo[],
    options: {
      includeExecutionMetrics?: boolean;
      includeComplexityAnalysis?: boolean;
      includeOptimizationSuggestions?: boolean;
    },
  ) {
    const executionEnabled = options.includeExecutionMetrics !== false;
    const complexityEnabled = options.includeComplexityAnalysis !== false;
    const availability = checkToolAvailability(toolChain, tools);
    const riskFactors = [...availability.errors, ...availability.warnings];
    const toolsForServer = indexToolsByServer(tools);
    const steps = toolChain.map(step => {
      const tool = toolsForServer(step.serverName)?.get(step.toolName);
      const metadata = tool?.discoverySource === 'fallback' ? undefined : tool;
      return { id: step.id, duration: metadata?.estimatedDuration, complexity: metadata?.estimatedComplexity };
    });

    const durations = steps.flatMap(step => step.duration ?? []);
    const serialDuration = durations.length === steps.length && durations.length
      ? durations.reduce((sum, duration) => sum + duration, 0)
      : null;
    const totalEstimatedDuration = executionEnabled && Number.isFinite(serialDuration) ? serialDuration : null;
    let bottleneckSteps: string[] = [];
    if (totalEstimatedDuration !== null) {
      const slowest = durations.reduce((max, duration) => Math.max(max, duration), 0);
      if (durations.some(duration => duration < slowest)) {
        bottleneckSteps = steps.filter(step => step.duration === slowest).map(step => step.id);
      }
    }

    const complexities = steps.flatMap(step => step.complexity ?? []);
    const averageComplexity = complexities.length === steps.length && complexities.length
      ? complexities.reduce((sum, value) => sum + value, 0) / complexities.length
      : null;
    const complexityDistribution: Record<string, number> = {};
    if (complexityEnabled) {
      for (const { complexity } of steps) {
        const level = complexity === undefined ? 'unavailable' : complexity <= 2 ? 'low' : complexity <= 4 ? 'medium' : 'high';
        complexityDistribution[level] = (complexityDistribution[level] ?? 0) + 1;
      }
      if (toolChain.filter(step => step.retryOnFailure).length > toolChain.length * 0.3) {
        riskFactors.push('High number of steps with retry logic may impact performance');
      }
    }

    const parallelizationPotential = executionEnabled ? this.calculateParallelizationPotential(toolChain) : null;
    if (executionEnabled && parallelizationPotential === null && toolChain.length) {
      riskFactors.push('Parallelization is unavailable because step dependencies are invalid or cyclic');
    }

    const suggestions: string[] = [];
    if (options.includeOptimizationSuggestions !== false) {
      if (bottleneckSteps.length) {
        suggestions.push(`Review the steps with the highest catalog duration estimates: ${bottleneckSteps.join(', ')}`);
      }
      if (complexityEnabled && averageComplexity !== null && averageComplexity > 4) {
        suggestions.push('Consider replacing high-complexity steps with simpler alternatives');
      }
      if (parallelizationPotential !== null && parallelizationPotential > 0.5) {
        suggestions.push('Consider running independent steps in parallel');
      }
    }

    return {
      metrics: {
        totalEstimatedDuration,
        averageComplexity: executionEnabled ? averageComplexity : null,
        bottleneckSteps,
        parallelizationPotential,
      },
      complexity: {
        overallComplexity: complexityEnabled ? averageComplexity : null,
        complexityDistribution,
        riskFactors,
      },
      suggestions,
    };
  }

  private calculateParallelizationPotential(toolChain: AnalysisStep[]): number | null {
    if (!toolChain.length) return null;
    const successors = new Map(toolChain.map(step => [step.id, [] as string[]]));
    if (successors.size !== toolChain.length) return null;

    const remaining = new Map<string, number>();
    let ready: string[] = [];
    for (const [index, step] of toolChain.entries()) {
      if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) return null;
      const dependencies = new Set(step.dependsOn ?? (index ? [toolChain[index - 1].id] : []));
      for (const mapping of Object.values(step.outputMapping ?? {})) {
        if (typeof mapping !== 'string') return null;
        dependencies.add(mapping.split('.')[0]);
      }
      for (const dependency of dependencies) {
        const dependents = successors.get(dependency);
        if (!dependents) return null;
        dependents.push(step.id);
      }
      remaining.set(step.id, dependencies.size);
      if (!dependencies.size) ready.push(step.id);
    }

    let processed = 0;
    let depth = 0;
    while (ready.length) {
      const next: string[] = [];
      for (const id of ready) {
        processed++;
        for (const dependent of successors.get(id)!) {
          const count = remaining.get(dependent)! - 1;
          remaining.set(dependent, count);
          if (count === 0) next.push(dependent);
        }
      }
      ready = next;
      depth++;
    }

    if (processed !== toolChain.length) return null;
    // Normalize the scheduling depth between a serial chain and a fully independent chain.
    return toolChain.length === 1 ? 0 : (toolChain.length - depth) / (toolChain.length - 1);
  }
}
