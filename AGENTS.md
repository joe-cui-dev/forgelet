# Agent Guide

This repo keeps documentation intentionally small so agents do not spend context on historical plans.

## Reading Order

1. Read `README.md` for the current CLI surface.
2. Read `CONTEXT.md` only for shared glossary terms.
3. Read `ROADMAP.md` for current direction and next slices.
4. Read source and tests for implementation truth.
5. Read only the relevant ADR when an architectural boundary is involved.

Do not default to reading deleted or historical planning docs from git history. Completed execution plans are not kept in `docs/`.

## Source Map

- CLI parsing and output: `src/cli/`
- Session orchestration: `src/agent/`, `src/workflows/`
- Tool registry and tools: `src/tools/`
- Permissions and read scope: `src/permissions/`, `src/readScope/`
- Model adapters and test clients: `src/models/`
- Trace, Sessions, and explain: `src/trace/`, `src/sessions/`, `src/explain/`
- Browser context bridge: `src/browser/`, `src/native-host/`
- Writing artifacts: `src/writingArtifacts/`
- Knowledge notes: `src/knowledge/`
- Active context compaction: `src/conversation/`
- Live terminal presentation: `src/sessionLiveView/`
- Smoke commands: `src/smoke/`
- Tests: `tests/`

## ADR Pointers

- CLI-first product boundary: `docs/adr/0001-local-cli-first.md`
- Tool providers and capabilities: `docs/adr/0002-tool-providers-and-capabilities.md`
- Workflow graph model: `docs/adr/0003-workflow-graphs-with-react-nodes.md`
- Capability grants: `docs/adr/0006-workflow-capability-grants.md`
- Knowledge Library storage: `docs/adr/0008-markdown-knowledge-library.md`
- Browser context bridge: `docs/adr/0010-browser-context-extension-bridge-first.md`
- Trace evidence contract: `docs/adr/0012-traces-record-real-session-events.md`
- Active Context compaction: `docs/adr/0013-active-context-uses-observation-digests.md`
- Session Continuation: `docs/adr/0014-session-resume-creates-immutable-continuations.md`
- Live View presentation: `docs/adr/0015-cli-session-live-view-is-presentation.md`
- Model-backed defaults: `docs/adr/0016-model-backed-sessions-are-the-default.md`
- Explicit workflow commands: `docs/adr/0017-explicit-workflow-commands.md`

## Working Rules

- Keep `CONTEXT.md` glossary-only.
- Put current usage in `README.md`.
- Put current and future sequencing in `ROADMAP.md`.
- Keep ADRs short and decision-focused.
- Delete completed execution plans instead of archiving them.
- Prefer source, tests, and `.forgelet/sessions/*.jsonl` traces over stale prose when behavior is in doubt.
