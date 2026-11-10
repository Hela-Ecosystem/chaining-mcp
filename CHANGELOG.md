# Changelog

All notable changes to this project.

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
