# Model-Backed Sessions Default Execution Plan

## Source Decisions

- Glossary term: `Session Preview` in `CONTEXT.md`.
- ADR: `docs/adr/0016-model-backed-sessions-are-the-default.md`.
- Existing related decisions:
  - `docs/adr/0005-workflow-stage-model-routing.md`
  - `docs/adr/0006-workflow-capability-grants.md`
  - `docs/adr/0012-traces-record-real-session-events.md`

## Goal

Make ordinary Forgelet Coding and Writing Workflow commands run model-backed Sessions by default:

```bash
forge "inspect this repo"
forge --act "fix the failing test"
forge write --context draft.md "revise this"
forge write --creative --style vivid "write a scene"
```

`--act` remains the explicit boundary for mutation-capable Coding Sessions. `--preview` becomes the explicit non-model path: it does not call a model, does not require a provider API key, and does not create a Session or Trace.

## Non-Goals

- Do not add a compatibility period for `--live`; remove it from parser behavior, README, help, smoke scripts, docs, and tests.
- Do not keep a user-facing scaffold Session mode such as `--scaffold`.
- Do not make `--preview` call provider APIs, validate network access, request approvals, create `.forgelet/sessions`, or write Trace events.
- Do not change Session Continuation semantics beyond replacing `forge --live --act` wording in docs; plain `forge resume` is already live/read-only by default.
- Do not add OpenAI or Anthropic live execution in this slice. Non-DeepSeek routes can be previewed as not runnable, while real execution remains strict.

## Behavior Contract

- `forge "<task>"` runs a model-backed read-only Coding Session.
- `forge --act "<task>"` runs a model-backed Coding Session with the actionable Coding Workflow capability path enabled.
- `forge write ...` runs a model-backed Writing Session.
- `forge --preview "<task>"` returns a Session Preview and does not create a Session or Trace.
- `forge --preview --act "<task>"` returns a Session Preview for the actionable Coding Workflow posture; it does not request approval or mutate anything.
- `forge write --preview ...` returns a Writing Workflow Session Preview.
- `--act` remains invalid for Writing Workflow runs, including `forge write --preview --act ...`.
- `--preview` does not require `DEEPSEEK_API_KEY`; it reports the required provider env var instead.
- A real model-backed run without the required provider env fails with a clear error that points to `.env` and `--preview`.
- `--preview --model <id>` reports the selected route and `Runnable: yes` only when current live execution supports that route. For unsupported routes, preview succeeds with `Runnable: no` and a reason; real execution fails.
- `--live` is an unknown option after this change.

## Delivery Slices

### Slice 1: Session Preview

Implement `--preview` as the explicit non-persistent planning surface before changing the default execution path.

Acceptance criteria:

- `src/cli/parseArgs.ts` replaces the run-command `live` field with `preview: boolean`.
- Parser accepts:
  - `forge --preview "<task>"`
  - `forge --preview --act "<task>"`
  - `forge --preview --context issue.md --allow-read src --budget 0.10 "<task>"`
  - `forge write --preview --context draft.md "revise this"`
  - `forge write --preview --creative --style vivid "write a scene"`
- Parser rejects:
  - `forge --live "<task>"`
  - `forge write --preview --act "revise this"`
  - missing values for existing options such as `--context`, `--allow-read`, `--model`, and `--budget`
- `src/cli/index.ts` handles preview before creating a model client or calling `runAgent(...)`.
- Preview loads local config and model routing with the same config path as real runs.
- Preview does not call `createLiveModelClient`, does not call `runAgent`, and does not create `.forgelet/sessions`.
- Preview output includes at least:
  - `Session Preview`
  - `Workflow`
  - optional workflow variant and creative input kind
  - `Task`
  - `Model route`
  - `Runnable: yes|no`
  - runnable reason when `no`
  - required provider env var, such as `DEEPSEEK_API_KEY`
  - `Budget`
  - `Action mode`
  - `Read scope`
  - context attachment paths
  - capability summary
  - `Persistence: none; no Session or Trace will be created`
- `--preview --act` reports action-capable Coding posture without requesting approvals.
- `--preview` for unsupported provider routes succeeds with `Runnable: no`.
- `src/cli/help.ts` documents `--preview` and does not mention `--live`.
- `CONTEXT.md` and ADR wording stay aligned with the implemented behavior.

Suggested TDD path:

1. Update `tests/cli/parseArgs.test.ts` to add `preview: false` on ordinary parsed runs and `preview: true` on preview runs.
2. Add parser tests proving `--live` is rejected as an unknown option.
3. Add parser tests for `forge --preview --act ...` and `forge write --preview ...`.
4. Add CLI integration tests in `tests/cli/cliIntegration.test.ts` proving preview does not call an injected `createLiveModelClient`.
5. Add a CLI integration test that runs preview in a temp workspace and asserts `.forgelet/sessions` is absent or empty.
6. Add preview output assertions for normal DeepSeek routing, unsupported `--model gpt-5`, action mode, read scope, and writing workflow variants.
7. Implement a small preview formatter in `src/cli/index.ts` or a sibling module if the formatting starts to crowd the CLI file.
8. Update help text after behavior is covered.

Implementation notes:

- Keep preview deterministic and local. It should call `loadDotEnv(...)` only if that remains harmless, but it must not fail when the env var is missing.
- Prefer reusing `loadConfig(...)` and `routeModel(...)` so preview matches real routing.
- Do not validate context file existence in preview unless the real run already does that before model execution. Preview is a run-shape inspection, not a full preflight.
- Capability text can be coarse in the first slice:
  - Coding read-only: workspace read, Git status/diff, plan updates
  - Coding action mode: workspace read, Git status/diff, plan updates, patch requests, configured command requests
  - Writing: model text generation and plan updates, no workspace/git/patch/command tools

### Slice 2: Model-Backed Sessions By Default

After `--preview` exists, remove `--live` and make ordinary run commands create a real model client by default.

Acceptance criteria:

- `ForgeCommand` no longer has a `live` field.
- `src/cli/parseArgs.ts` rejects `--live`.
- `src/cli/index.ts` creates a live model client for every non-preview run command.
- `runCli(["inspect repo"], { createLiveModelClient })` calls the injected model-client factory.
- `runCli(["write", ...], { createLiveModelClient })` calls the injected model-client factory with `workflow: "writing"`.
- `onLiveEvent` is available for ordinary model-backed runs, not gated behind `command.live`.
- Real runs without the required DeepSeek API key fail with wording like:

```text
DEEPSEEK_API_KEY is required for model-backed Sessions. Set it in .env, or run forge --preview "<task>" to inspect routing without calling a model.
```

- Real runs with non-DeepSeek model routes still fail before model execution with current provider-support wording updated away from `--live`.
- `src/workflows/index.ts` removes the scaffold-only fallback for public CLI execution. If `runWorkflowSession(...)` or `runAgent(...)` still accepts an optional `modelClient` for tests, update comments so it is clear this is a deterministic test seam, not user-facing behavior.
- Tests that currently call `runAgent(...)` without a model client should either:
  - intentionally remain low-level scaffold tests if the seam is still useful, with wording that does not describe CLI behavior, or
  - be updated to pass `FakeModelClient` when they assert real Session behavior.
- `tests/cli/cliIntegration.test.ts` updates all `["--live", ...]` invocations to ordinary default run commands.
- `tests/cli/cliIntegration.test.ts` updates `["--live", "--act", ...]` to `["--act", ...]`.
- `tests/cli/cliIntegration.test.ts` updates writing tests from `["write", "--live", ...]` to `["write", ...]`.
- Scaffold-output assertions such as `Execution is scaffolded` are removed from CLI expectations.
- `README.md`, `src/cli/help.ts`, `src/smoke/writingCreative.ts`, `tests/smoke/writingCreativeSmoke.test.ts`, and any docs found by `rg -- '--live'` are updated to the new command shape.
- The writing artifact continuation plan, if still present, should be updated from `forge write --live ...` to `forge write ...` so handoff docs do not reintroduce the old flag.

Suggested TDD path:

1. Update parser tests to remove `live` from expected command objects and assert `--live` is unknown.
2. Update CLI integration tests proving ordinary coding and writing runs call `createLiveModelClient`.
3. Update live-view integration tests by removing `--live` from argv while keeping the event expectations.
4. Update action tests by changing `--live --act` to `--act`.
5. Update missing-key and unsupported-route tests to run ordinary commands and assert new error wording.
6. Remove or rewrite the CLI scaffold assertion in the session list/show test.
7. Change `runCli(...)` to create model clients for ordinary run commands and to gate only preview away from model execution.
8. Remove `command.live` checks and comments that describe real model execution as opt-in.
9. Update README/help/smoke/docs with `rg -n -- '--live|scaffold|scaffolded'`.
10. Run focused tests, then full validation.

Implementation notes:

- Keep `createLiveModelClient` as an injectable name for now if renaming it causes unnecessary churn; a later cleanup can rename it to `createModelClient`.
- The first model-backed default implementation can keep DeepSeek-only live support. The decision is about default execution, not provider breadth.
- Be careful with `stdout` and `stderr`: stdout should remain final summary for real Sessions, and preview output can use stdout because it is the final command result.
- Do not silently fallback to preview or scaffold when provider setup is missing. Failing loudly is part of the behavior contract.
- Do not write Trace events for preview, including context attachment previews.

## Validation

Run focused tests first:

```bash
npm test -- tests/cli/parseArgs.test.ts tests/cli/cliIntegration.test.ts tests/smoke/writingCreativeSmoke.test.ts
```

Then run the full repo gates:

```bash
npm test
npm run typecheck
npm run build
```

Optional manual checks after build:

```bash
node dist/cli/index.js --preview "inspect this repo"
node dist/cli/index.js --preview --act "fix the failing test"
node dist/cli/index.js write --preview --creative --style vivid "write a scene"
node dist/cli/index.js --live "inspect this repo"
```

Expected manual behavior:

- The three preview commands print Session Preview output and create no `.forgelet/sessions/*.jsonl`.
- The `--live` command fails as an unknown option.

If a DeepSeek key is available, run one narrow dogfood Session after all deterministic gates pass:

```bash
npm run smoke:deepseek
node dist/cli/index.js --allow-read README.md --budget 0.10 "summarize the CLI defaults"
```

## Files Likely To Change

- `src/cli/parseArgs.ts`
- `src/cli/index.ts`
- `src/cli/help.ts`
- `src/workflows/index.ts`
- `src/smoke/writingCreative.ts`
- `tests/cli/parseArgs.test.ts`
- `tests/cli/cliIntegration.test.ts`
- `tests/smoke/writingCreativeSmoke.test.ts`
- `README.md`
- docs found by `rg -n -- '--live|scaffold|scaffolded'`

## Search Handles

Use these to find stale behavior and wording:

```bash
rg -n -- '--live|command\.live|live:|Execution is scaffolded|scaffolded Session|scaffold only|no model turn was run' src tests README.md docs package.json
```
