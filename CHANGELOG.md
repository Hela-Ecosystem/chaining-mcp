# Changelog
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
