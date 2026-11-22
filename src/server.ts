import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { MCPServerDiscovery } from './core/discovery.js';
import { SmartRouteOptimizer } from './core/optimizer.js';
import { TimeManager } from './managers/time-manager.js';
import { PromptRegistry } from './prompts/prompt-registry.js';
import { AwesomeCopilotIntegration } from './integrations/awesome-copilot-integration.js';
import { WorkflowOrchestrator, type MCPTransport } from './managers/workflow-orchestrator.js';
import { LLMManager } from './managers/llm-manager.js';

import { allTools } from './tools/tool-registry.js';
import { chainingResources } from './resources/resource-definitions.js';
import { ResourceHandlers } from './resources/resource-handlers.js';
import { RequestHandlers } from './handlers/request-handlers.js';
import { HttpAdapter } from './transport/http-adapter.js';
import { RunStore } from './agent/run-store.js';
import { MCP_SERVER_VERSION } from './version.js';

const LOCAL_SERVERS = new Set(['local', 'hela-mitosis', 'mitosis', 'chaining-mcp', 'chaining-mcp-server']);
const LOCAL_TOOLS = new Set(allTools.map(tool => tool.name));
const NON_REENTRANT = new Set(['workflow_orchestrator', 'agent_run']);

export class ChainingMCPServer {
  private server: Server;
  private discovery: MCPServerDiscovery;
  private optimizer: SmartRouteOptimizer;
  private timeManager: TimeManager;
  private promptRegistry: PromptRegistry;
  private awesomeCopilotIntegration: AwesomeCopilotIntegration;
  private workflowOrchestrator: WorkflowOrchestrator;
  private llmManager: LLMManager;
  private resourceHandlers: ResourceHandlers;
  private requestHandlers: RequestHandlers;
  private runStore: RunStore;
  private httpAdapter?: HttpAdapter;
  private isInitialized: boolean = false;

  constructor({ runtimeTransport }: { runtimeTransport?: MCPTransport } = {}) {
    // Initialize core services
    this.discovery = new MCPServerDiscovery();
    this.optimizer = new SmartRouteOptimizer();
    this.timeManager = new TimeManager();
    this.promptRegistry = new PromptRegistry();
    this.awesomeCopilotIntegration = new AwesomeCopilotIntegration();
    this.workflowOrchestrator = new WorkflowOrchestrator();
    this.llmManager = new LLMManager();

    // Initialize handlers
    this.resourceHandlers = new ResourceHandlers(
      this.discovery,
      this.promptRegistry,
      this.awesomeCopilotIntegration,
      this.workflowOrchestrator,
      this.llmManager
    );

    this.requestHandlers = new RequestHandlers(
      this.discovery,
      this.optimizer,
      this.timeManager,
      this.promptRegistry,
      this.awesomeCopilotIntegration,
      this.workflowOrchestrator,
      this.llmManager
    );

    this.workflowOrchestrator.setTransport(async (serverName, toolName, parameters, signal) => {
      const isLocal = LOCAL_SERVERS.has(serverName);
      const prefix = isLocal ? 'hela_mitosis_' : `${serverName.replace(/-/g, '_')}_`;
      const name = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;
      if (NON_REENTRANT.has(name)) {
        throw new Error(`tool '${name}' is not re-entrant inside workflows`);
      }
      if (!isLocal) {
        if (!runtimeTransport) throw new Error(`No runtime transport bound for server '${serverName}'`);
        return runtimeTransport(serverName, name, parameters, signal);
      }
      if (!LOCAL_TOOLS.has(name)) throw new Error(`Unknown tool: ${name}`);
      return this.requestHandlers.handleToolCall(name, parameters, signal);
    });

    this.runStore = new RunStore();
    this.workflowOrchestrator.attachRunStore(this.runStore);

    // Initialize MCP server
    this.server = this.createMcpServer();
  }

  public createMcpServer(): Server {
    const server = new Server(
      {
        name: 'chaining-mcp-server',
        version: MCP_SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers(server);
    return server;
  }

  private setupHandlers(server: Server = this.server): void {
    // List tools handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: allTools,
      };
    });

    // Call tool handler
    server.setRequestHandler(CallToolRequestSchema, async (request, { signal }) => {
      const { name, arguments: args } = request.params;

      try {
        await this.ensureInitialized();

        const result = await this.requestHandlers.handleToolCall(name, args, signal);
        // A handler that reports ok:false is a failure, even though it returned a
        // structured body instead of throwing; the MCP envelope must say so.
        const failed = typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
        return {
          ...(failed ? { isError: true } : {}),
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        const errorMessage = this.formatErrorMessage(error, name, args);
        return {
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
          isError: true,
        };
      }
    });

    // List resources handler
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      return {
        resources: chainingResources,
      };
    });

    // Read resource handler
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      try {
        await this.ensureInitialized();

        const result = await this.resourceHandlers.handleReadResource(uri);
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }, null, 2)
          }],
          isError: true,
        };
      }
    });
  }

  /**
   * Format error messages with enhanced information and suggestions
   */
  private formatErrorMessage(error: unknown, toolName: string, args: any): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `Tool execution failed for '${toolName}': ${errorMessage}`;
  }

  /**
   * Ensure the server is initialized with robust error handling
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      try {
        console.error('Initializing chaining MCP server...');

        await this.discovery.discoverServers();
        console.error(`Discovered ${this.discovery.getServers().length} MCP servers`);

        await this.discovery.analyzeTools();
        console.error(`Analyzed ${this.discovery.getTools().length} tools`);

        this.optimizer.setTools(this.discovery.getTools());

        this.isInitialized = true;
        console.error('Chaining MCP server initialization completed successfully');
      } catch (error) {
        console.error('Failed to initialize chaining MCP server:', error);
        // Don't throw error - allow server to continue with limited functionality
      }
    }
  }

  /**
   * Start the server (stdio by default, http opt-in)
   */
  async start(options: { transport?: 'stdio' | 'http'; port?: number; host?: string } = {}): Promise<void> {
    const transportMode = options.transport || (process.env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio');
    if (transportMode === 'http') {
      const port = options.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 8011);
      const host = options.host ?? process.env.HOST ?? '0.0.0.0';
      this.httpAdapter = new HttpAdapter(() => this.createMcpServer(), { port, host, runStore: this.runStore });
      await this.httpAdapter.start();
    } else {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error('Chaining MCP Server started and running on stdio');
    }
  }

  /**
   * Stop the server gracefully
   */
  async stop(): Promise<void> {
    if (this.httpAdapter) {
      await this.httpAdapter.close();
    }
    this.runStore.close();
  }
}
