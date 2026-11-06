# HeLa Mitosis: canonical tools

Server version **3.0.0**. Generated from the ecosystem schema catalog; regenerate with `npm run docs:generate -- --servers` in the ecosystem checkout.

Only names advertised by `tools/list` are listed here. Older aliases in migration examples are not additional tools. Runtime namespace prefixes are optional and do not change these server-local names.

## `agent_run` (conditional)

Run a task through the Needle agent runtime: plans with the local model, executes tools via the workflow orchestrator, escalates to OpenRouter only on low confidence or failure. Requires MITOSIS_AGENT_ENABLED=true and a fetched engine (npm run needle:fetch).

## `analyze_tool_chain_performance`

Analyze performance metrics and efficiency of tool chains. Provides execution time estimates, complexity analysis, and optimization suggestions

## `analyze_tools`

Analyzes available tools from discovered MCP servers

## `analyze_with_sequential_thinking`

Analyzes complex workflows using sequential thinking

## `brainstorming`

Generate creative ideas via a generative model (requires CHAINING_LLM_ENABLED with OPENROUTER_API_KEY; fails honestly without a key — no template ideas)

## `convert_time`

Convert time between timezones

## `generate_route_suggestions`

Generates optimal route suggestions for a given task

## `get_current_time`

Get current time in a specific timezone

## `get_prompt`

Get a specific prebuilt prompt by ID

## `get_resource_set`

Get a specific resource set by ID

## `get_skill`

Load a skill's full instructions (SKILL.md body) plus its file manifest, for injection into agent context or harness use.

## `get_tool_chain_analysis`

Gets comprehensive analysis of available tools and suggested routes

## `list_mcp_servers`

Lists all discovered MCP servers on the system

## `list_skills`

List all discovered agent skills (name, description, files) from the local skills catalog. Read-only; never executes skill scripts.

## `llm_decompose_task` (conditional)

Decompose a complex goal into ordered subtasks with recommended tool categories. [Legacy compat API — routes via the Needle planner when MITOSIS_AGENT_ENABLED=true.]

## `llm_query` (conditional)

Execute a direct query using the internal LLM engine (OpenRouter/OpenAI compatible, disabled by default)

## `llm_suggest_route` (conditional)

Use LLM intelligence to score and rank optimal multi-tool execution routes. [Legacy compat API — prefer agent_run when MITOSIS_AGENT_ENABLED=true.]

## `llm_summarize` (conditional)

Compress verbose tool outputs, logs, or multi-step execution results

## `load_instruction`

Loads a custom instruction from the repository

## `search_instructions`

Searches custom instructions based on keywords in their descriptions

## `search_prompts`

Search for prompts by keywords, category, or tags

## `search_resource_sets`

Search for resource sets by keywords, category, or tags

## `search_skills`

Search the skills catalog by keywords against names and descriptions. Returns ranked matches for chaining.

## `sequentialthinking`

Think one step with the Mitosis agent: your thought is recorded as an observation in AgentState, Needle decides the next action (call_tool/revise/complete/escalate), and the result feeds the next step. Pass sessionId to continue a session.

## `suggest_skill_chain`

Plan a task with Needle over registry tools and attach skill recommendations per step (deterministic catalog match, labeled). Combines skills+tools into one executable chain.

## `validate_tool_chain`

Validate tool chains for correctness, dependencies, and potential issues. Checks for circular dependencies, tool availability, and parameter compatibility

## `workflow_cancel`

Request cancellation of a running workflow

## `workflow_orchestrator`

Execute complex multi-server workflows across the MCP ecosystem with dependency management and error handling

## `workflow_status`

Get the current status and step results of a workflow executed by workflow_orchestrator or agent_run
