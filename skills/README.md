# Bundled AgentSkills

`chaining-mcp` ships a small set of read-only AgentSkills so an installed server can guide an agent without requiring the host's private skill registry.

Bundled skills (source snapshots):

- `human-writing` (`7c0de1f`) — evidence-based technical prose and documentation editing.
- `caveman` (`82f99a1`) — RTK-first, minimal execution and output shaping.
- `mema-vault` (`aaa341d`) — local encrypted credential-management workflows.
- `blotcat-illustrations` (`851ac9c`) — Blotcat illustration planning, generation, and QA.
- `skill-finder` — discovery and installation guidance for additional skills.

The runtime exposes these through `list_skills`, `search_skills`, and `get_skill`. `get_skill` can load `SKILL.md` or a relative file under the selected skill, including references and scripts. The MCP never executes bundled skill scripts.

The four packaged snapshots are sourced from the Hela skill registry. Runtime state is intentionally excluded: no vault database, salt, backup, `.env`, or memory database is packaged from `mema-vault`. The license and attribution boundaries stated inside each skill remain applicable; the Hela Mitosis GPL license does not silently replace embedded third-party notices such as the CC BY-SA attribution in `human-writing`.
