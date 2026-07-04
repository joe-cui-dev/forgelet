# Forgelet Roadmap

Forgelet is a local-first personal Agent Kernel with a CLI-first surface. V1 is dogfoodable: Coding Sessions can inspect, edit with approval, verify, and explain changes; Writing and Learning workflows can produce saved artifacts and source-linked outputs.

## Current Product Shape

Forgelet should remain a workbench for code, writing, learning, browser context, knowledge notes, and durable memory. It should not become a hidden autonomous assistant. Durable writes, command execution, memory persistence, and external effects require explicit boundaries and trace evidence.

Current implemented surfaces:

- `forge code` for read-only and actionable Coding Sessions.
- `forge write` for prose revision, creative drafting, browser-backed writing, saved Writing Artifacts, artifact continuation, and artifact catalog search.
- `forge learn` for source-backed Learning Packs from files or browser context.
- `forge notes create/search` for project-scope Knowledge Notes promoted from completed Learning Sessions.
- `forge browser read-current` and `forge browser install-host` for read-only browser snapshots.
- `forge resume` for child Session Continuations.
- `forge sessions`, `forge explain`, `forge memory suggest/accept`, and config commands for review and operation.

## Next Candidate Slices

1. Minimal Writing Project continuity:
   Add a small project manifest that groups Writing Artifacts and lets `forge write --project <slug>` continue a long-form work without introducing a full document editor.

2. Project memory review workflow:
   Turn memory suggestions into a clearer review surface while keeping writes user-approved and traceable.

3. Diagnose workflow:
   Add a debugging workflow that follows reproduce, minimize, hypothesize, instrument, fix, and regression-test stages.

4. Test discovery improvements:
   Help Coding Sessions find the right verification command before editing.

5. Model pricing and diagnostics:
   Make provider/model availability, routing, and estimated cost easier to inspect.

6. Local review UI:
   Add an inspect-and-review web surface after the CLI workflows remain stable.

## Non-Goals

- Hidden browser automation, cookie access, form submission, or background scraping.
- Silent Durable Memory writes.
- Silent Knowledge Library note creation.
- General life-assistant behavior before core workbench workflows are reliable.
- Plugin/MCP expansion before provider, capability, permission, and trace boundaries are solid.
- Long completed execution plans in `docs/`.

## Durable Constraints

- CLI execution remains first-class.
- Workflows expose only the Capabilities they are granted.
- Trace records real Session events, not simulated progress.
- Active Context can be compacted, but Trace remains immutable evidence.
- Browser context is user-approved read-only input.
- Knowledge Notes are human-facing Markdown artifacts, not Durable Memory.
- ADRs hold durable architectural decisions; `README.md`, `CONTEXT.md`, and this roadmap hold current operating context.
