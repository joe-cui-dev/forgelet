# Agent Guide

This repo keeps documentation intentionally small so agents do not spend context on historical plans.

## Reading Order

1. Read `README.md` for the current CLI surface.
2. Read `CONTEXT.md` only for shared glossary terms.
3. Read `ROADMAP.md` for current direction and next slices.
4. Read source and tests for implementation truth.
5. Read only the relevant ADR when an architectural boundary is involved.

Do not default to reading deleted or historical planning docs from git history. Completed execution plans are not kept in `docs/`.

## Commands

- Build: `npm run build` (tsc plus browser extension bundling)
- Typecheck: `npm run typecheck` (uses `tsconfig.test.json`)
- Test: `npm test` — do not run `npx jest` directly; the script sets `--experimental-vm-modules` for ESM and forces `--runInBand`
- Smoke: `npm run smoke:writing`, `smoke:learning`, `smoke:knowledge-notes`, `smoke:writing-artifacts`, `smoke:memory-review`, `smoke:deepseek` (each runs a build first)
- Requires Node >= 24

## Source Map

- CLI split by responsibility under `src/cli/`: dispatch (`index.ts`), arg parsing (`parseArgs.ts`), per-domain output formatting (`present/`), `run`/`resume` command bodies (`commands/`), model-client and approval-handler assembly (`wiring.ts`), interactive terminal glue (`terminal.ts`)
- Agent Kernel session shell and bounded ReAct node: `src/kernel/`
- Workflow definitions and typed entries: `src/workflows/`
- Tool registry and tools: `src/tools/`
- Permissions and read scope: `src/permissions/`, `src/readScope/`
- Model adapters, provider-for-model mapping and runnability (`routing.ts`), and test clients: `src/models/`
- Workflow-to-model routing (`routeModel`) and user config: `src/config/`
- Trace, Sessions, and explain: `src/trace/`, `src/sessions/`, `src/explain/`
- Debug transcripts (separate from traces): `src/debugTranscript/`
- Browser context bridge: `src/browser/`, `src/native-host/`
- Browser Workbench application Module: `src/browserWorkbench/`
- Shared Learning Session Launcher: `src/sessionLauncher/`
- Writing artifacts: `src/writingArtifacts/`
- Writing project manifests, continuation heads, and project run preparation rules: `src/writingProjects/`
- Creative style presets: `src/creativeStylePresets/`
- Knowledge notes: `src/knowledge/`
- User-approved memory persistence: `src/memory/`
- Project Memory Review read model, Compatibility Import, and decision-log records: `src/memoryReview/`
- Context attachments loaded into a session: `src/context/`
- Active context compaction (rolling summary, fact ledger, fold): `src/conversation/`
- Live terminal presentation: `src/sessionLiveView/`
- Smoke commands: `src/smoke/`
- Shared types and small helpers: `src/types.ts`, `src/budget/`, `src/fileNames/`, `src/workspace/`
- Tests: `tests/`

Note: `src/context/` handles per-session file attachments; `src/conversation/` handles compacting the active conversation. They are not the same thing.

## ADR Index

ADR filenames are self-describing (for example `0019-conversation-folds-into-rolling-summary-with-fact-ledger.md`). When a task touches an architectural boundary, list `docs/adr/` and read only the ADRs whose filenames match the area you are changing. Do not read the whole directory.

## Working Rules

- Keep `CONTEXT.md` glossary-only.
- Put current usage in `README.md`.
- Put current and future sequencing in `ROADMAP.md`.
- Keep ADRs short and decision-focused.
- Delete completed execution plans instead of archiving them.
- When adding a top-level `src/` directory, add it to the Source Map above in the same change.
- Prefer source, tests, and `.forgelet/sessions/*.jsonl` traces over stale prose when behavior is in doubt.

## Agent skills

### Issue tracker

Work items live in GitHub Issues for `joe-cui-dev/forgelet`; external PRs are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

Forgelet is single-context: use the root `CONTEXT.md` and relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.
