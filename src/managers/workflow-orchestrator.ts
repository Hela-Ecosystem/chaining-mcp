import { WorkflowStep, WorkflowOrchestratorInput } from '../types.js';
import { checkCapability, resolveProfile, type HelaCapabilityContract, type HelaInvocationMeta } from '../agent/capability-policy.js';
import type { RunStore } from '../agent/run-store.js';
import { wrapHelaResult } from '../agent/hela-result.js';
import { toolResultError } from '../agent/execution-result.js';

export interface WorkflowRunOptions {
  /** Durable store for step records; enables resume after restart. */
  runStore?: RunStore;
  /** Skip steps already recorded completed for this workflow id. */
  resume?: boolean;
  /**
   * P0-B3: explicit operator opt-in to re-run 'unknown'-outcome steps
   * (orphaned running / expired handles). Default false = unknown steps
   * are reported, never blindly replayed.
   */
  retryUnknown?: boolean;
}

/** Dispatch a tool call to the named MCP server. */
export type MCPTransport = (
  serverName: string,
  toolName: string,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface WorkflowExecutionResult {
  workflowId: string;
  status: 'completed' | 'failed' | 'running' | 'cancelled';
  steps: WorkflowStepResult[];
  overallResult: any;
  executionTime: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowStepResult {
  stepId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  serverName: string;
  toolName: string;
  startedAt?: string;
  completedAt?: string;
  executionTime?: number;
  result?: any;
  error?: string;
  retryCount?: number;
  dependencies?: string[];
}

export class WorkflowOrchestrator {
  private activeWorkflows = new Map<string, WorkflowExecutionResult>();
  private workflowControllers = new Map<string, AbortController>();
  private transport?: MCPTransport;
  /** Registry guard: when set, agent-driven executeTool rejects anything not listed. */
  private allowedTools?: Set<string>;
  /** Durable run store (P0-B1). Attached per process; unset = memory-only. */
  private runStore?: RunStore;

  /** Bind the real MCP transport (e.g. RequestHandlers.handleToolCall). */
  setTransport(transport: MCPTransport): void {
    this.transport = transport;
  }

  /** Attach a durable RunStore; step records then survive restarts. */
  attachRunStore(store: RunStore): void {
    this.runStore = store;
  }

  /** Restrict agent-driven tool calls to an explicit registry. */
  setAllowedTools(tools: string[]): void {
    this.allowedTools = new Set(tools);
  }

  clearAllowedTools(): void {
    this.allowedTools = undefined;
  }

  /**
   * Safe single-tool capability for the agent runtime: registry-guarded,
   * transported, cancellable. Retries are NOT applied here — the agent loop
   * decides re-attempts from observations; workflow steps use step config.
   */
  async executeTool(toolName: string, parameters: Record<string, any> = {}, opts: { serverName?: string; signal?: AbortSignal; contract?: HelaCapabilityContract; run?: HelaInvocationMeta; envelope?: boolean } = {}): Promise<any> {
    if (opts.signal?.aborted) throw new Error(`tool '${toolName}' aborted before execution`);
    if (this.allowedTools && !this.allowedTools.has(toolName)) {
      throw new Error(`tool '${toolName}' is not in the agent tool registry`);
    }
    if (opts.contract) {
      const decision = checkCapability(opts.contract, resolveProfile());
      if (!decision.allowed) throw new Error(`policy denied: ${decision.reason}`);
    }
    // P0-B2: propagate run_id/step_id to the durable store when attached.
    const store = this.runStore;
    const runId = opts.run?.run_id;
    const stepId = opts.run?.step_id;
    if (store && runId && stepId) store.startStep(runId, stepId, opts.serverName || 'local', toolName, parameters);
    const startedAt = new Date().toISOString();
    try {
      const result = await this.callMCPServerTool(opts.serverName || 'local', toolName, parameters, opts.signal);
      if (store && runId && stepId) {
        // RunStore keeps the RAW payload so resume restores raw results.
        store.saveStepResult(runId, stepId, result);
        const error = toolResultError(result);
        store.finishStep(runId, stepId, error ? 'failed' : 'completed', error ?? 'ok');
      }
      // P1-C1: opt-in canonical envelope; default raw path unchanged.
      if (opts.envelope) {
        return wrapHelaResult(result, {
          serverName: opts.serverName || 'local', toolName,
          contract: opts.contract, run: opts.run, startedAt,
        });
      }
      return result;
    } catch (error) {
      if (store && runId && stepId) {
        store.finishStep(runId, stepId, 'failed', error instanceof Error ? error.message : 'Unknown error');
      }
      throw error;
    }
  }

  async executeWorkflow(input: WorkflowOrchestratorInput, callerSignal?: AbortSignal, runOpts: WorkflowRunOptions = {}): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const workflowId = input.workflowId;
    const store = runOpts.runStore || this.runStore;
    if (this.workflowControllers.has(workflowId)) throw new Error(`Workflow '${workflowId}' is already running`);

    // P0-B1/B2: durable run record; re-invoking the same workflow id with
    // resume:true skips steps already recorded completed (kill -9 safe).
    if (store) store.createRun(input.description || input.name || workflowId, { runId: workflowId, workflowId });

    // Initialize workflow execution
    const execution: WorkflowExecutionResult = {
      workflowId,
      status: 'running',
      steps: [],
      overallResult: {},
      executionTime: 0,
      startedAt: new Date().toISOString(),
    };

    const controller = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
    const timeoutError = new Error(`Workflow timed out after ${input.timeout}ms`);
    const timer = input.timeout === undefined ? undefined : setTimeout(() => controller.abort(timeoutError), input.timeout);
    this.workflowControllers.set(workflowId, controller);
    this.activeWorkflows.set(workflowId, execution);

    try {
      // Build execution plan
      const executionPlan = this.buildExecutionPlan(input.steps);

      // Execute steps in order. P0-B3: on resume first reconcile orphaned
      // 'running' steps (dead process) into 'unknown' — outcome genuinely
      // unknown, never auto-treated as failed or silently replayed.
      let resumed = new Set<string>();
      let unknowns = new Set<string>();
      if (runOpts.resume && store) {
        const orphaned = store.markOrphanedRunningAsUnknown(workflowId);
        if (orphaned > 0) store.recordEvent(workflowId, 'resume_reconcile', { orphaned, note: 'running -> unknown' });
        resumed = store.completedStepIds(workflowId);
        unknowns = store.unknownStepIds(workflowId);
        store.recordEvent(workflowId, 'resume', { resumed: [...resumed], unknowns: [...unknowns], retryUnknown: !!runOpts.retryUnknown });
      }
      let firstFailure: WorkflowStepResult | undefined;
      for (const stepGroup of executionPlan) {
        if (signal.aborted) break;
        const batch = await Promise.allSettled(stepGroup.map(step => this.executeStep(step, input, execution, signal, {
          store, resumed, unknowns, retryUnknown: runOpts.retryUnknown,
        })));
        for (const outcome of batch) {
          if (outcome.status === 'rejected') throw outcome.reason;
          if (outcome.value.status === 'failed') firstFailure ??= outcome.value;
        }
        if (input.failFast && firstFailure) break;
      }

      if (signal.aborted) {
        execution.status = signal.reason === timeoutError ? 'failed' : 'cancelled';
        execution.error = signal.reason === timeoutError ? timeoutError.message : 'workflow cancelled';
      } else if (firstFailure) {
        execution.status = 'failed';
        execution.error = input.failFast ? firstFailure.error : 'One or more workflow steps failed';
      } else {
        execution.status = 'completed';
      }

    } catch (error) {
      execution.status = 'failed';
      execution.error = error instanceof Error ? error.message : 'Unknown error during workflow execution';
    } finally {
      clearTimeout(timer);
      this.workflowControllers.delete(workflowId);
      execution.overallResult = this.aggregateResults(execution.steps, input.steps.length);
      execution.executionTime = Date.now() - startTime;
      execution.completedAt = new Date().toISOString();
      this.activeWorkflows.set(workflowId, execution);
      if (store) {
        store.recordEvent(workflowId, 'workflow_end', { status: execution.status, error: execution.error });
        store.finishRun(workflowId, execution.status === 'completed' ? 'completed' : execution.status === 'cancelled' ? 'cancelled' : 'failed');
      }
    }

    return execution;
  }

  private buildExecutionPlan(steps: WorkflowStep[]): WorkflowStep[][] {
    const executed = new Set<string>();
    const inProgress = new Set<string>();
    const result: WorkflowStep[][] = [];

    while (executed.size < steps.length) {
      const currentBatch: WorkflowStep[] = [];

      for (const step of steps) {
        if (executed.has(step.id) || inProgress.has(step.id)) {
          continue;
        }

        // Check if all dependencies are satisfied
        const dependenciesSatisfied = !step.dependsOn ||
          step.dependsOn.every(depId => executed.has(depId));

        if (dependenciesSatisfied) {
          currentBatch.push(step);
          inProgress.add(step.id);
        }
      }

      if (currentBatch.length === 0) {
        // No steps can be executed - likely circular dependency
        throw new Error('Circular dependency detected or unsatisfied dependencies in workflow');
      }

      result.push(currentBatch);

      // Mark batch as executed
      currentBatch.forEach(step => {
        executed.add(step.id);
        inProgress.delete(step.id);
      });
    }

    return result;
  }

  private async executeStep(
    step: WorkflowStep,
    workflow: WorkflowOrchestratorInput,
    execution: WorkflowExecutionResult,
    signal: AbortSignal,
    runCtx: { store?: RunStore; resumed?: Set<string>; unknowns?: Set<string>; retryUnknown?: boolean } = {},
  ): Promise<WorkflowStepResult> {
    const startedAt = new Date();
    const stepResult: WorkflowStepResult = {
      stepId: step.id,
      status: 'running',
      serverName: step.serverName,
      toolName: step.toolName,
      startedAt: startedAt.toISOString(),
      dependencies: step.dependsOn,
    };

    execution.steps.push(stepResult);

    // P0-B2 resume: restore the previously recorded result, skip execution.
    if (runCtx.resumed?.has(step.id) && runCtx.store) {
      const saved = runCtx.store.getRun(execution.workflowId)?.steps.find(s => s.step_id === step.id);
      let result: unknown = { resumed: true };
      try { if (saved?.result) result = JSON.parse(saved.result); }
      catch { /* A stored result may have been truncated. */ }
      const failure = toolResultError(result);
      if (failure) {
        stepResult.status = 'failed';
        stepResult.error = failure;
        runCtx.store.finishStep(execution.workflowId, step.id, 'failed', failure);
      } else {
        stepResult.status = 'completed';
        stepResult.result = result;
      }
      stepResult.completedAt = new Date().toISOString();
      return stepResult;
    }

    // P0-B3: unknown outcome (orphaned running / expired handle) is NOT
    // failure. Only re-run when the step declares idempotent:true or the
    // operator explicitly passed retryUnknown:true. Otherwise report and
    // stop without a blind replay of a possibly-completed side effect.
    if (runCtx.unknowns?.has(step.id) && runCtx.store) {
      const replayable = (step as { idempotent?: boolean }).idempotent === true || runCtx.retryUnknown === true;
      if (!replayable) {
        stepResult.status = 'failed';
        stepResult.error = `unknown outcome for step '${step.id}': prior attempt orphaned; explicit retry required (mark idempotent:true or resume with retryUnknown:true)`;
        stepResult.completedAt = new Date().toISOString();
        runCtx.store.recordEvent(execution.workflowId, 'unknown_blocked', { step_id: step.id });
        return stepResult;
      }
      runCtx.store.recordEvent(execution.workflowId, 'unknown_retry', { step_id: step.id, idempotent: (step as { idempotent?: boolean }).idempotent === true });
    }

    const maxRetries = step.retryOnFailure ? (step.maxRetries ?? 1) : 0;
    try {
      if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('maxRetries must be a non-negative integer');
      const resolvedParams = this.resolveParameters(step, execution.steps, workflow.variables);
      for (let retryCount = 0; ; retryCount++) {
        signal.throwIfAborted();
        stepResult.retryCount = retryCount;
        runCtx.store?.startStep(execution.workflowId, step.id, step.serverName, step.toolName, resolvedParams);
        let result: unknown;
        try {
          result = await this.callMCPServerTool(step.serverName, step.toolName, resolvedParams, signal);
          signal.throwIfAborted();
          const failure = toolResultError(result);
          if (failure) throw new Error(failure);
        } catch (error) {
          if (retryCount >= maxRetries || signal.aborted) throw error;
          continue;
        }

        runCtx.store?.saveStepResult(execution.workflowId, step.id, result);
        runCtx.store?.finishStep(execution.workflowId, step.id, 'completed', 'ok');
        stepResult.status = 'completed';
        stepResult.result = result;
        break;
      }
    } catch (error) {
      stepResult.status = 'failed';
      stepResult.error = error instanceof Error ? error.message : String(error);
      runCtx.store?.finishStep(execution.workflowId, step.id, 'failed', stepResult.error);
    } finally {
      const completedAt = new Date();
      stepResult.completedAt = completedAt.toISOString();
      stepResult.executionTime = completedAt.getTime() - startedAt.getTime();
    }
    return stepResult;
  }

  private resolveParameters(
    step: WorkflowStep,
    completedSteps: WorkflowStepResult[],
    globalVariables?: Record<string, any>
  ): Record<string, any> {
    const resolved = { ...step.parameters };

    // Substitute global variables
    if (globalVariables) {
      Object.keys(resolved).forEach(key => {
        if (typeof resolved[key] === 'string' && resolved[key].startsWith('$')) {
          const varName = resolved[key].substring(1);
          if (globalVariables[varName] !== undefined) {
            resolved[key] = globalVariables[varName];
          }
        }
      });
    }

    // Apply output mapping from dependent steps
    if (step.outputMapping) {
      Object.entries(step.outputMapping).forEach(([paramName, outputPath]) => {
        const [stepId, outputKey] = outputPath.split('.');
        const sourceStep = completedSteps.find(s => s.stepId === stepId);

        if (sourceStep?.status === 'completed' && sourceStep.result && sourceStep.result[outputKey] !== undefined) {
          resolved[paramName] = sourceStep.result[outputKey];
        }
      });
    }

    return resolved;
  }

  private async callMCPServerTool(
    serverName: string,
    toolName: string,
    parameters: Record<string, any>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.transport) throw new Error(`No transport bound for server '${serverName}'`);
    return this.transport(serverName, toolName, parameters, signal);
  }

  private aggregateResults(steps: WorkflowStepResult[], totalSteps: number): any {
    const aggregated = Object.fromEntries(steps
      .filter(step => step.status === 'completed' && step.result !== undefined)
      .map(step => [step.stepId, step.result]));

    // Create summary
    aggregated.summary = {
      totalSteps,
      completedSteps: steps.filter(s => s.status === 'completed').length,
      failedSteps: steps.filter(s => s.status === 'failed').length,
      totalExecutionTime: steps.reduce((sum, s) => sum + (s.executionTime || 0), 0),
    };

    return aggregated;
  }

  getWorkflowStatus(workflowId: string): WorkflowExecutionResult | null {
    return this.activeWorkflows.get(workflowId) || null;
  }

  cancelWorkflow(workflowId: string): boolean {
    const controller = this.workflowControllers.get(workflowId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error('workflow cancelled'));
    return true;
  }

  getActiveWorkflows(): string[] {
    return Array.from(this.activeWorkflows.keys()).filter(id => {
      const workflow = this.activeWorkflows.get(id);
      return workflow && workflow.status === 'running';
    });
  }

  getStats(): { activeWorkflows: number; completedWorkflows: number; failedWorkflows: number; total: number } {
    const all = Array.from(this.activeWorkflows.values());
    return {
      activeWorkflows: all.filter(w => w.status === 'running').length,
      completedWorkflows: all.filter(w => w.status === 'completed').length,
      failedWorkflows: all.filter(w => w.status === 'failed').length,
      total: all.length,
    };
  }
}
