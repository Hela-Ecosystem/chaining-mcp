# Changelog
## [3.2.0] - 2026-11-27

### Added
- Passive mode for external DAG coordinators: `MITOSIS_EXTERNAL_ORCHESTRATOR` limits `tools/list` and dispatch to an explicit allow-list, refuses other tools with `MITOSIS_PASSIVE_MODE`, keeps the agent and Needle off, keeps run state in memory, refuses writes into coordinator-owned workspace directories (`MITOSIS_RESERVED_PATH`), and adds `mode` and `externalOrchestrator` to `/healthz`. Unset, behaviour is unchanged. (`chaining-mcp#30`)

## [3.1.3] - 2026-11-25

### Fixed
- A cross-cell `workflow_orchestrator` step with no runtime transport now names `HELA_RUNTIME_URL` in its failure message. The runtime (hela-runtime 1.4.3) sets the variable itself when it hosts Mitosis, and an operator-set value wins; the message and the README env table say so. (`chaining-mcp#28`, ISS-61)
- `llm_suggest_route`, `generate_route_suggestions` and `llm_decompose_task` use the model-backed tool timeout budget (default 90s, cap 300s) instead of the 10s interactive timeout. (`chaining-mcp#28`, ISS-62)
- `get_skill` returns distinct errors for a disallowed path, a file not in the skill (listing the available files) and an unknown skill. `maxChars` bounds the body (content plus file list) and no longer charges the description. (`chaining-mcp#28`, ISS-63)
- `search_prompts` with a `category` or `complexity` filter that matches nothing returns an empty result with a `note` instead of substituting prompts from another category. (`chaining-mcp#28`, ISS-63)
- Prompt guidance matches `expectedTools` against cell-prefixed tool names (`hela_membrane_read_file`) as well as bare names. (`chaining-mcp#28`, ISS-63)

## [3.1.2] - 2026-11-23

### Fixed
- Prompt `expectedTools` reference real HeLa tools again: `run_terminal_cmd` -> `hela_nucleus_execute_command`, `grep` -> `hela_membrane_search_in_files`, `list_dir` -> `hela_membrane_list_directory`, `search_replace` -> `hela_membrane_write_file`, `todo_write` -> `hela_genome_create_mission`, and the `awesome_copilot_*` entries resolve to the real instruction tools. A test now checks every entry against the catalog. (`chaining-mcp#27`)
- `search_prompts` / `search_resource_sets` derive their `category` enum from the prompt data instead of a fixed six values, so all 52 prompts are reachable by category.
- The instruction `local_fallback` is always marked `status: degraded` with a notice describing the two heading-outline stubs, and the dangling `reactjs`/`nextjs` collection entries are removed.
- `sequentialthinking` with `execute:false` records a `proposed_call` instead of a `tool_call`, so state no longer claims a call that did not happen.

## [3.1.1] - 2026-11-22

### Changed
- `get_skill` marks a lossy answer as degraded. When the file list or content is cut to respect `maxChars`, the response carries `status: "degraded"` and `degraded.reason` naming what was dropped, so `hela.pipe` can report `status: "degraded"` instead of a clean success. (`hela-mcp-ecosystem#8`)

## [3.1.0] - 2026-11-22

### Changed
- `workflow_orchestrator` dispatches to named cells. With `HELA_RUNTIME_URL` set, a step for a sibling cell runs through `hela.pipe` over streamable HTTP; local tools still run in-process. Without a runtime, a sibling step fails with a clear reason instead of silently reporting completion. Failed steps read `{ok:false}`/`{success:false}`/`isError` as failures, `failFast` stops dependent work, and retries run per step. (`chaining-mcp#22`)
- Planner tools name a tool or say why they cannot. Catalogs are scoped and ranked before Needle sees them (376 -> 8), escalation must return exact tool names, and all five planners report `source`, `degraded`, `plannerError` and `omittedSteps` instead of claiming "Validated"/"grounded". Any `ok:false` result is now an MCP error. (`chaining-mcp#23`)
- The analysis tools stop inventing numbers. `get_tool_chain_analysis` recommends only registry tools (no confidence score), `analyze_tool_chain_performance` shares `validate_tool_chain` diagnostics and computes parallelization from real dependencies, and `analyze_tools` uses the cell as category with `null` for unknown complexity. (`chaining-mcp#25`)

### Fixed
- `agent_run` records `success:false` as a failure, refuses a `complete` that follows no successful call, scopes standalone clock requests to `get_current_time`, and no longer treats a duplicate call as saturation. (`chaining-mcp#24`)
- Skill frontmatter parses quotes, block scalars (`|`, `>`, `>-`), chomping indicators and inline comments; a malformed SKILL.md is reported with its file instead of "unknown skill"; `maxChars` bounds the serialized response (file list first). (`chaining-mcp#26`)

## [3.0.9] - 2026-11-22

### Fixed
- Peer discovery is runtime-aware. Under `hela-runtime` the ten cells sit behind one endpoint and never appear in client configs, so discovery found nothing and `validate_tool_chain` reported every real tool as unavailable — `read_file` on `hela-membrane` included. The runtime's generated `config/tool-catalog.json` is now read as an additional source (via `HELA_ECOSYSTEM_ROOT`, then any managed installation), contributing each cell and its tools. Verified against the installed catalog: 10 cells, 299 tools, `read_file` resolves. `list_mcp_servers` and the analysis tools built on discovery see the same fix.

### Changed
- Tool availability now has three outcomes instead of two: a discovered server with a missing tool is an error; a server that was not discovered, or a run with no catalog at all, is a warning ("could not be verified"). Reporting the second as the first made the validator reject correct plans, which is the dangerous direction. Short server names (`membrane`) also resolve against `hela-` prefixed cells. (`chaining-mcp#21`)


All notable changes to this project.

## [3.0.8] - 2026-11-19

### Changed
- Upgrade Zod to 4.6 and glob to 14, preserving schema and discovery behavior.

## [3.0.6] - 2026-11-18

### Added
- Bundled the registry `pcb` skill for read-only discovery through Mitosis, including KiCad workflow references, independent verification scripts, JLCPCB preparation guidance, and preserved MIT licensing.
- Documented the recommended PCB workflow across Mitosis, Genome, Membrane, Nucleus, Cytosol, and Enzyme.

### Fixed
- The skill bundle shipped with a second copy of itself nested at `skills/pcb/pcb` (154 duplicated files, 3.3 MB); the duplicate is removed so `get_skill` and discovery see one definition.

## [3.0.3] - 2026-11-13

### Fixed
- Replaced Unix-only cleanup with the portable Node maintenance runner.

## [3.0.2] - 2026-11-11

### Added
- Bundled `human-writing`, `caveman`, `mema-vault`, and `blotcat-illustrations` as read-only internal Hela skills.
- Added packaged skill-file loading through `get_skill` without executing bundled scripts.

### Security
- Removed personal filesystem paths, Git identity data, and personal-name examples from distributed skill files.
- Excluded Mema Vault databases, salts, backups, environment files, and memory databases from the bundle.

## [3.0.1] - 2026-11-11

### Added
- **Automatic LLM activation** — the LLM integration enables itself when `OPENROUTER_API_KEY` or `OPENAI_API_KEY` is present, while an explicit `CHAINING_LLM_ENABLED` value still takes precedence.

### Changed
- Updated repository references to the Hela-Ecosystem organization.
- Declared the project under the GNU GPL-3.0-or-later license.

### Fixed
- Deterministic test execution now exits after all assertions complete, preventing lingering test-runner processes from blocking release checks.

## [3.0.0] - 2026-10-31

### Changed
- **Version reset to 3.0.0** — per-server version metadata baseline reset (Phase 7). All `package.json`, MCP `ServerInfo.version`, and HTTP metadata now report `3.0.0`. This is a metadata/interface baseline reset; for `hela-plastid` it is not an upgrade from the previous `4.2.0` advert.
