/**
 * Awesome Copilot Integration Module
 *
 * Provides integration with the awesome-copilot MCP server to access
 * collections, instructions, and prompts for enhanced development workflows.
 */

export interface AwesomeCopilotCollection {
  id: string;
  name: string;
  description: string;
  tags: string[];
  items: {
    path: string;
    kind: string;
  }[];
}

export interface AwesomeCopilotInstruction {
  mode: string;
  filename: string;
  content: string;
  metadata?: {
    title?: string;
    description?: string;
    tags?: string[];
    category?: string;
  };
}

export interface AwesomeCopilotSearchResult {
  filename: string;
  title: string;
  description: string;
  tags: string[];
  category?: string;
}

/** Honest description of what the built-in fallback is (and is not). */
export const LOCAL_FALLBACK_NOTICE =
  'local_fallback is degraded: it serves two bundled heading outlines, not the awesome-copilot repository. Configure the awesome-copilot MCP server (and GITHUB_TOKEN) for the full instructions.';

export const LOCAL_STUB_CONTENT_NOTICE =
  '> Local stub: this is a heading outline only, not the full awesome-copilot instruction.';

export class AwesomeCopilotIntegration {
  private collections: Map<string, AwesomeCopilotCollection> = new Map();
  private instructions: Map<string, AwesomeCopilotInstruction> = new Map();
  private isInitialized: boolean = false;

  constructor() {
    this.initialize();
  }

  /**
   * Initialize the integration by loading available collections and instructions
   */
  private async initialize(): Promise<void> {
    try {
      console.error('Initializing awesome-copilot integration...');

      // Load collections (this would normally call the awesome-copilot MCP server)
      await this.loadCollections();

      // Load instructions
      await this.loadInstructions();

      this.isInitialized = true;
      console.error('Awesome-copilot integration initialized successfully');
    } catch (error) {
      console.error('Failed to initialize awesome-copilot integration:', error);
      // Continue with partial functionality if integration fails
    }
  }

  /**
   * Load collections from awesome-copilot.
   *
   * These are local stubs, not the awesome-copilot repository. A collection may
   * only list items `load_instruction` can actually return, so every entry
   * points at one of the bundled instruction summaries; prompts and chat modes
   * are not bundled and would be dangling references (chaining-mcp#27).
   */
  private async loadCollections(): Promise<void> {
    try {
      // This is a placeholder - in real implementation, we'd call:
      // const collections = await this.callAwesomeCopilotTool('list_collections');

      const mockCollections: AwesomeCopilotCollection[] = [
        {
          id: 'typescript-mcp-development',
          name: 'TypeScript MCP Server Development (local stub)',
          description: 'Local heading-outline stub for TypeScript/Node.js MCP servers; the full awesome-copilot toolkit needs the awesome-copilot MCP server',
          tags: ['typescript', 'mcp', 'model-context-protocol', 'nodejs', 'server-development'],
          items: [
            { path: 'instructions/typescript-mcp-server.instructions.md', kind: 'instruction' }
          ]
        },
        {
          id: 'python-mcp-development',
          name: 'Python MCP Server Development (local stub)',
          description: 'Local heading-outline stub for Python MCP servers; the full awesome-copilot toolkit needs the awesome-copilot MCP server',
          tags: ['python', 'mcp', 'model-context-protocol', 'fastmcp', 'server-development'],
          items: [
            { path: 'instructions/python-mcp-server.instructions.md', kind: 'instruction' }
          ]
        }
      ];

      mockCollections.forEach(collection => {
        this.collections.set(collection.id, collection);
      });

      console.error(`Loaded ${mockCollections.length} collections from awesome-copilot`);
    } catch (error) {
      console.error('Failed to load collections:', error);
      throw error;
    }
  }

  /**
   * Load instructions from awesome-copilot (mock implementation)
   */
  private async loadInstructions(): Promise<void> {
    try {
      // This is a placeholder - in real implementation, we'd call the awesome-copilot MCP server
      const mockInstructions: AwesomeCopilotInstruction[] = [
        {
          mode: 'instructions',
          filename: 'typescript-mcp-server.instructions.md',
          content: `${LOCAL_STUB_CONTENT_NOTICE}
# TypeScript MCP Server Development

## Overview
This guide covers building Model Context Protocol (MCP) servers using TypeScript and Node.js.

## Key Concepts
- MCP Protocol fundamentals
- Tool and resource definitions
- Error handling and validation
- Testing MCP servers

## Best Practices
1. Use proper TypeScript types
2. Implement robust error handling
3. Write comprehensive tests
4. Follow MCP protocol specifications
5. Document your server capabilities`,
          metadata: {
            title: 'TypeScript MCP Server Development (local stub)',
            description: 'Local stub: heading outline only; the full guide needs the awesome-copilot MCP server',
            tags: ['typescript', 'mcp', 'server-development'],
            category: 'development'
          }
        },
        {
          mode: 'instructions',
          filename: 'python-mcp-server.instructions.md',
          content: `${LOCAL_STUB_CONTENT_NOTICE}
# Python MCP Server Development

## Overview
This guide covers building Model Context Protocol (MCP) servers using Python and FastMCP.

## Key Concepts
- FastMCP framework usage
- Tool and resource definitions
- Async/await patterns
- Error handling and validation

## Best Practices
1. Use proper type hints
2. Implement async operations correctly
3. Write comprehensive unit tests
4. Follow MCP protocol specifications
5. Document your server capabilities`,
          metadata: {
            title: 'Python MCP Server Development (local stub)',
            description: 'Local stub: heading outline only; the full guide needs the awesome-copilot MCP server',
            tags: ['python', 'mcp', 'fastmcp', 'server-development'],
            category: 'development'
          }
        }
      ];

      mockInstructions.forEach(instruction => {
        this.instructions.set(`${instruction.mode}/${instruction.filename}`, instruction);
      });

      console.error(`Loaded ${mockInstructions.length} instructions from awesome-copilot`);
    } catch (error) {
      console.error('Failed to load instructions:', error);
      throw error;
    }
  }

  /**
   * Get all available collections
   */
  getCollections(): AwesomeCopilotCollection[] {
    return Array.from(this.collections.values());
  }

  /**
   * Get a specific collection by ID
   */
  getCollection(id: string): AwesomeCopilotCollection | undefined {
    return this.collections.get(id);
  }

  /**
   * Search collections by query
   */
  searchCollections(query: string): AwesomeCopilotCollection[] {
    const lowerQuery = query.toLowerCase();
    return this.getCollections().filter(collection =>
      collection.name.toLowerCase().includes(lowerQuery) ||
      collection.description.toLowerCase().includes(lowerQuery) ||
      collection.tags.some(tag => tag.toLowerCase().includes(lowerQuery))
    );
  }

  /**
   * Get all available instructions
   */
  getInstructions(): AwesomeCopilotInstruction[] {
    return Array.from(this.instructions.values());
  }

  /**
   * Get a specific instruction by path
   */
  getInstruction(mode: string, filename: string): AwesomeCopilotInstruction | undefined {
    return this.instructions.get(`${mode}/${filename}`);
  }

  /**
   * Search instructions by keywords
   */
  searchInstructions(keywords: string): AwesomeCopilotSearchResult[] {
    const lowerKeywords = keywords.toLowerCase();
    return this.getInstructions()
      .filter(instruction =>
        instruction.metadata?.title?.toLowerCase().includes(lowerKeywords) ||
        instruction.metadata?.description?.toLowerCase().includes(lowerKeywords) ||
        instruction.metadata?.tags?.some(tag => tag.toLowerCase().includes(lowerKeywords)) ||
        instruction.filename.toLowerCase().includes(lowerKeywords)
      )
      .map(instruction => ({
        filename: instruction.filename,
        title: instruction.metadata?.title || instruction.filename,
        description: instruction.metadata?.description || '',
        tags: instruction.metadata?.tags || [],
        category: instruction.metadata?.category
      }));
  }

  /**
   * Get collections by tags
   */
  getCollectionsByTags(tags: string[]): AwesomeCopilotCollection[] {
    return this.getCollections().filter(collection =>
      tags.some(tag => collection.tags.includes(tag))
    );
  }

  /**
   * Get instructions by category
   */
  getInstructionsByCategory(category: string): AwesomeCopilotInstruction[] {
    return this.getInstructions().filter(instruction =>
      instruction.metadata?.category === category
    );
  }

  /**
   * Check if integration is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }

  /**
   * Get integration status and statistics
   */
  getStatus(): {
    isReady: boolean;
    collectionsCount: number;
    instructionsCount: number;
    lastUpdated?: Date;
  } {
    return {
      isReady: this.isReady(),
      collectionsCount: this.collections.size,
      instructionsCount: this.instructions.size,
      lastUpdated: this.isInitialized ? new Date() : undefined
    };
  }

  /**
   * Refresh data from awesome-copilot (placeholder for future implementation)
   */
  async refresh(): Promise<void> {
    console.error('Refreshing awesome-copilot data...');
    // In real implementation, this would reload data from the MCP server
    await this.initialize();
  }
}
