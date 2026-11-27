import { glob } from 'glob';
import { readFile, readdir, stat, access } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { spawn, ChildProcess } from 'child_process';
import { orchestratorMode } from '../config/orchestrator-mode.js';
import { MCPServerInfo, ToolInfo, MCPServerInfoSchema } from '../types.js';
import { ConfigLoader } from '../config/config-loader.js';
import { DiscoveryConfig, EssentialServerConfig, FallbackToolConfig } from '../config/discovery-config.js';

function catalogEstimates(tool: { estimatedComplexity?: unknown; estimatedDuration?: unknown }) {
  const { estimatedComplexity, estimatedDuration } = tool;
  return {
    ...(typeof estimatedComplexity === 'number' && estimatedComplexity >= 1 && estimatedComplexity <= 10
      ? { estimatedComplexity } : {}),
    ...(typeof estimatedDuration === 'number' && Number.isFinite(estimatedDuration) && estimatedDuration >= 0
      ? { estimatedDuration } : {}),
  };
}

export class MCPServerDiscovery {
  private servers: Map<string, MCPServerInfo> = new Map();
  private tools: Map<string, ToolInfo> = new Map();
  private configLoader: ConfigLoader;
  private config!: DiscoveryConfig;
  private lastDiscoveryTime: number = 0;
  private lastAnalyzeTime: number = 0;
  private cacheTtlMs: number = 60000;
  private cacheHits: number = 0;
  private cacheMisses: number = 0;

  constructor() {
    this.configLoader = new ConfigLoader();
  }

  /**
   * Locate the runtime's generated tool catalog.
   *
   * Under `hela-runtime` the ten cells sit behind one endpoint and never appear in
   * client configs, so config-based discovery sees none of them. The catalog is
   * written and revision-validated by the ecosystem build, and knows every cell's
   * tools (chaining-mcp#21).
   */
  private async helaCatalogPath(): Promise<string | null> {
    const candidates: string[] = [];
    const root = process.env.HELA_ECOSYSTEM_ROOT;
    if (root) candidates.push(join(root, 'config', 'tool-catalog.json'));

    const installations = join(homedir(), '.local', 'share', 'hela', 'installations');
    try {
      for (const entry of await readdir(installations, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          candidates.push(join(installations, entry.name, 'hela-mcp-ecosystem', 'config', 'tool-catalog.json'));
        }
      }
    } catch { /* no managed installations on this host */ }

    for (const candidate of candidates) {
      try {
        await access(candidate);
        return candidate;
      } catch { /* try the next candidate */ }
    }
    return null;
  }

  /** Cells and tools from the runtime catalog, empty when it is unavailable. */
  private async loadHelaCatalog(): Promise<{ servers: MCPServerInfo[]; tools: ToolInfo[] }> {
    const catalogPath = await this.helaCatalogPath();
    if (!catalogPath) return { servers: [], tools: [] };

    try {
      const parsed = JSON.parse(await readFile(catalogPath, 'utf-8'));
      const cells: Record<string, any> = parsed?.cells ?? {};
      const servers: MCPServerInfo[] = [];
      const tools: ToolInfo[] = [];

      for (const [id, cell] of Object.entries(cells)) {
        const variants: any[] = Array.isArray(cell?.variants) ? cell.variants : [];
        const byName = new Map<string, any>();
        for (const variant of variants) {
          for (const tool of variant?.tools ?? []) {
            if (tool?.name) byName.set(tool.name, tool);
          }
        }
        servers.push(MCPServerInfoSchema.parse({
          name: id,
          command: 'hela-runtime',
          args: [id],
          env: {},
          description: `${id} (runtime catalog)`,
          version: typeof cell?.version === 'string' ? cell.version : '0.0.0',
          capabilities: { tools: true, resources: false, prompts: false },
        }));
        for (const tool of byName.values()) {
          tools.push({
            name: tool.name,
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
            serverName: id,
            category: id,
            ...catalogEstimates(tool),
          });
        }
      }

      return { servers, tools };
    } catch {
      return { servers: [], tools: [] };
    }
  }

  /**
   * Discover MCP servers from common configuration locations
   */
  async discoverServers(forceRefresh = false): Promise<MCPServerInfo[]> {
    const now = Date.now();
    if (!forceRefresh && this.servers.size > 0 && (now - this.lastDiscoveryTime < this.cacheTtlMs)) {
      this.cacheHits++;
      return Array.from(this.servers.values());
    }
    this.cacheMisses++;

    // Load configuration
    this.config = await this.configLoader.loadConfig();

    // Get config paths from configuration
    const configPaths = this.configLoader.expandPaths(this.config.configPaths);

    // Add package.json files that might contain MCP server configs (bounded)
    const packageJsonPaths = await this.findPackageJsonFiles();
    configPaths.push(...packageJsonPaths);

    const discoveredServers: MCPServerInfo[] = [];

    for (const configPath of configPaths) {
      try {
        const servers = await this.loadServersFromConfig(configPath);
        discoveredServers.push(...servers);
      } catch (error) {
        // Config file doesn't exist or is invalid, continue
        continue;
      }
    }

    // Also try to discover from environment variables
    const envServers = this.discoverFromEnvironment();
    discoveredServers.push(...envServers);

    // Add essential servers from configuration
    const essentialServers = this.getEssentialServers();
    discoveredServers.push(...essentialServers);

    // The runtime catalog covers cells that client configs cannot see.
    const catalog = await this.loadHelaCatalog();
    for (const server of catalog.servers) {
      if (!discoveredServers.some((candidate) => candidate.name === server.name)) {
        discoveredServers.push(server);
      }
    }
    for (const tool of catalog.tools) {
      if (!this.tools.has(tool.name) || this.tools.get(tool.name)?.discoverySource === 'fallback') {
        this.tools.set(tool.name, tool);
      }
    }

    // Store discovered servers
    for (const server of discoveredServers) {
      this.servers.set(server.name, server);
    }
    this.lastDiscoveryTime = Date.now();

    return Array.from(this.servers.values());
  }

  /**
   * Find package.json files that might contain MCP server configurations
   */
  private async findPackageJsonFiles(): Promise<string[]> {
    try {
      const patterns = [
        'package.json',
        'mcp-servers.json',
        '.mcp/servers.json',
      ];

      const files: string[] = [];
      for (const pattern of patterns) {
        const matches = await glob(pattern, {
          maxDepth: 2,
          ignore: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
          cwd: process.cwd(),
        });
        files.push(...matches);
      }

      return files;
    } catch (error) {
      return [];
    }
  }

  /**
   * Load servers from a configuration file
   */
  private async loadServersFromConfig(configPath: string): Promise<MCPServerInfo[]> {
    try {
      const content = await readFile(configPath, 'utf-8');
      const config = JSON.parse(content);

      // Handle Cursor MCP configuration format
      if (config.mcpServers) {
        return Object.entries(config.mcpServers).map(([name, serverConfig]: [string, any]) => {
          return MCPServerInfoSchema.parse({
            name,
            command: serverConfig.command,
            args: serverConfig.args || [],
            env: serverConfig.env || {},
            description: `MCP server: ${name}`,
            version: '1.0.0',
            capabilities: {
              tools: true,
              resources: false,
              prompts: false,
            },
          });
        });
      }

      // Handle other config formats
      if (config.servers) {
        return config.servers.map((server: any) => MCPServerInfoSchema.parse(server));
      } else if (Array.isArray(config)) {
        return config.map((server: any) => MCPServerInfoSchema.parse(server));
      } else if (config.command) {
        return [MCPServerInfoSchema.parse(config)];
      }

      return [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Discover servers from environment variables
   */
  private discoverFromEnvironment(): MCPServerInfo[] {
    const servers: MCPServerInfo[] = [];

    // Look for MCP_SERVERS environment variable
    const mcpServers = process.env.MCP_SERVERS;
    if (mcpServers) {
      try {
        const parsed = JSON.parse(mcpServers);
        if (Array.isArray(parsed)) {
          servers.push(...parsed.map((server: any) => MCPServerInfoSchema.parse(server)));
        }
      } catch (error) {
        // Invalid JSON, ignore
      }
    }

    return servers;
  }

  /**
   * Get essential servers from configuration
   */
  private getEssentialServers(): MCPServerInfo[] {
    return this.config.essentialServers.map(server => MCPServerInfoSchema.parse(server));
  }

  /**
   * Analyze tools from discovered servers
   */
  async analyzeTools(forceRefresh = false): Promise<ToolInfo[]> {
    const now = Date.now();
    if (!forceRefresh && this.tools.size > 0 && (now - this.lastAnalyzeTime < this.cacheTtlMs)) {
      this.cacheHits++;
      return Array.from(this.tools.values());
    }
    this.cacheMisses++;

    const tools: ToolInfo[] = [];

    for (const [serverName, serverInfo] of this.servers) {
      try {
        const serverTools = await this.extractToolsFromServer(serverName, serverInfo);
        tools.push(...serverTools);
      } catch (error) {
        // Add fallback tools for known server types
        const fallbackTools = this.getFallbackTools(serverName, serverInfo);
        tools.push(...fallbackTools);
      }
    }

    // Store tools
    for (const tool of tools) {
      const existing = this.tools.get(tool.name);
      if (tool.discoverySource === 'fallback' && existing && existing.discoverySource !== 'fallback') continue;
      this.tools.set(tool.name, existing?.serverName === tool.serverName && existing.discoverySource !== 'fallback'
        ? { ...catalogEstimates(existing), ...tool }
        : tool);
    }
    this.lastAnalyzeTime = Date.now();

    return tools;
  }

  /**
   * Extract tools from a specific server
   */
  private async extractToolsFromServer(serverName: string, serverInfo: MCPServerInfo): Promise<ToolInfo[]> {
    const tools: ToolInfo[] = [];

    // Passive mode launches nothing: a configured server could start work or write into the coordinator's workspace.
    if (orchestratorMode().passive) return this.getFallbackTools(serverName, serverInfo);

    try {
      // Try to connect to the server and query its tools
      const serverTools = await this.queryServerTools(serverName, serverInfo);
      tools.push(...serverTools);
    } catch (error) {
      // If connection fails, use fallback tools based on server name/type
      const fallbackTools = this.getFallbackTools(serverName, serverInfo);
      tools.push(...fallbackTools);
    }

    return tools;
  }

  /**
   * Query a server for its tools using MCP protocol
   */
  private async queryServerTools(serverName: string, serverInfo: MCPServerInfo): Promise<ToolInfo[]> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess | null = null;
      const timeout = setTimeout(() => {
        if (child) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
        reject(new Error(`Timeout connecting to server ${serverName}`));
      }, 1000); // 1 second timeout per server

      try {
        child = spawn(serverInfo.command, serverInfo.args, {
          env: { ...process.env, ...serverInfo.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let output = '';
        let errorOutput = '';

        child.stdout?.on('data', (data) => {
          output += data.toString();
        });

        child.stderr?.on('data', (data) => {
          errorOutput += data.toString();
        });

        child.on('error', (error) => {
          clearTimeout(timeout);
          reject(new Error(`Failed to spawn server ${serverName}: ${error.message}`));
        });

        child.on('close', (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Server ${serverName} exited with code ${code}: ${errorOutput}`));
            return;
          }

          try {
            // Parse the MCP response to extract tools
            const tools = this.parseMCPToolsResponse(output, serverName);
            resolve(tools);
          } catch (parseError) {
            reject(new Error(`Failed to parse response from server ${serverName}: ${parseError instanceof Error ? parseError.message : String(parseError)}`));
          }
        });

        // Send MCP list_tools request
        const request = {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        };

        child.stdin?.write(JSON.stringify(request) + '\n');
        child.stdin?.end();

      } catch (error) {
        clearTimeout(timeout);
        if (child) {
          try { (child as ChildProcess).kill('SIGKILL'); } catch (_) {}
        }
        reject(new Error(`Failed to query server ${serverName}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  /**
   * Parse MCP tools response
   */
  private parseMCPToolsResponse(output: string, serverName: string): ToolInfo[] {
    const lines = output.split('\n').filter(line => line.trim());
    const tools: ToolInfo[] = [];

    for (const line of lines) {
      try {
        const response = JSON.parse(line);
        if (response.result?.tools) {
          for (const tool of response.result.tools) {
            tools.push({
              name: tool.name,
              description: tool.description || `Tool from ${serverName}`,
              inputSchema: tool.inputSchema || {},
              serverName,
              category: this.inferCategory(tool.name, tool.description),
              ...catalogEstimates(tool),
            });
          }
        }
      } catch (error) {
        // Skip invalid JSON lines
        continue;
      }
    }

    return tools;
  }

  /**
   * Get fallback tools for known server types from configuration
   */
  private getFallbackTools(serverName: string, serverInfo: MCPServerInfo): ToolInfo[] {
    const tools: ToolInfo[] = [];

    // Find matching fallback tool configuration
    for (const fallbackConfig of this.config.fallbackTools) {
      const regex = new RegExp(fallbackConfig.serverPattern, 'i');
      if (regex.test(serverName)) {
        // Add tools from this configuration
        for (const toolDef of fallbackConfig.tools) {
          tools.push({
            name: toolDef.name,
            description: toolDef.description,
            inputSchema: toolDef.inputSchema,
            serverName,
            category: toolDef.category,
            discoverySource: 'fallback',
            estimatedComplexity: toolDef.estimatedComplexity,
            estimatedDuration: toolDef.estimatedDuration,
          });
        }
      }
    }

    return tools;
  }

  /**
   * Infer tool category from name and description using configuration rules
   */
  private inferCategory(name: string, description?: string): string {
    const text = `${name} ${description || ''}`.toLowerCase();

    // Check against configured category rules
    for (const rule of this.config.categoryRules) {
      if (text.includes(rule.pattern)) {
        return rule.category;
      }
    }

    return 'utility'; // Default category
  }

  /**
   * Get all discovered servers
   */
  getServers(): MCPServerInfo[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get all discovered tools
   */
  getTools(): ToolInfo[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: string): ToolInfo[] {
    return this.getTools().filter(tool => tool.category === category);
  }

  /**
   * Get tools by server
   */
  getToolsByServer(serverName: string): ToolInfo[] {
    return this.getTools().filter(tool => tool.serverName === serverName);
  }

  /**
   * Reload configuration and rediscover servers
   */
  async reloadConfiguration(): Promise<void> {
    this.config = await this.configLoader.loadConfig();
    this.servers.clear();
    this.tools.clear();
    await this.discoverServers();
    await this.analyzeTools();
  }

  /**
   * Get current configuration
   */
  getConfiguration(): DiscoveryConfig {
    return this.config;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { cacheHits: number; cacheMisses: number; serversCount: number; toolsCount: number; lastDiscoveryTime: number; lastAnalyzeTime: number } {
    return {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      serversCount: this.servers.size,
      toolsCount: this.tools.size,
      lastDiscoveryTime: this.lastDiscoveryTime,
      lastAnalyzeTime: this.lastAnalyzeTime,
    };
  }
}
