# Bundled PCB Skill

This is the sanitized, read-only distribution of the registry `pcb` skill for
HeLa Mitosis. It provides KiCad schematic, placement, routing, verification,
and JLCPCB preparation guidance together with the independent Python checkers
and references used by the skill.

## HeLa routing

Use this skill through the following organelle chain:

1. **Mitosis** plans the hardware workflow and keeps each phase gated.
2. **Genome** records requirements, pinouts, decisions, BOM evidence, and bring-up results.
3. **Membrane** reads and writes the project deliverables while preserving the required clean layout.
4. **Nucleus** runs KiCad, Python, ERC/DRC, Gerber, and independent verification commands.
5. **Cytosol** performs optional visual inspection of renders, datasheets, and supplier pages when available.
6. **Enzyme** researches datasheets, component availability, and manufacturer evidence when online research is needed.

Mitosis only exposes this package as guidance. The MCP server does not execute
the bundled scripts implicitly; the active agent must route execution through
the selected profile's filesystem and terminal capabilities.

## Requirements

- KiCad CLI and, for Python geometry checks, the compatible `pcbnew` bindings.
- A project-specific working directory; never write generated artifacts into
  this skill directory.
- Human confirmation before any supplier cart, order, payment, or fabrication
  submission.

The package contains no credentials, browser state, personal paths, vault data,
or project-specific boards. The upstream license and attribution are preserved
in [`LICENSE`](LICENSE).
