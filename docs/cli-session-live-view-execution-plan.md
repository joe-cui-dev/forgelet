# CLI Session Live View Execution Plan

## Source Decisions

- Glossary terms: `Session Live View` and `Model Output Stream` in `CONTEXT.md`.
- Roadmap issue: `FORGELET_LONG_TERM_PLAN_V2_V3.md`, V2 Issue 9.
- ADR: `docs/adr/0015-cli-session-live-view-is-presentation.md`.

## Goal

Make model-backed Sessions visibly progress in an interactive terminal without waiting for the final Session summary, while keeping the Trace evidence-first and stdout script-friendly.

## Non-Goals

- Do not implement provider-level token or chunk streaming in the first slice.
- Do not add spinner or waiting text to the Trace.
- Do not build the Local Review UI.
- Do not add verbose budget, compaction, plan-update, or read-range rendering in the default view.

## Delivery Slices

### Slice 1: End-to-End Session Live View

Implement a terminal Session Live View using structured runner events and CLI stderr rendering.

Acceptance criteria:

- `src/sessionLiveView/index.ts` defines `SessionLiveEvent`, `SessionLiveEventSink`, and a terminal formatter.
- `runAgent` and `runWorkflowSession` accept an optional live-event sink.
- All model-backed Sessions can emit the default event set:
  - Session start
  - Trace path
  - model turn start and finish
  - tool call start and finish
  - permission checkpoint
  - command start and finish
  - Session completed, stopped, or failed with reason
- Scaffold-only runs do not enable Session Live View by default.
- Interactive CLI entrypoint enables Session Live View automatically for model-backed Sessions when stdout and stderr are TTYs.
- Non-interactive `runCli()` and piped CLI output remain script-friendly unless a future explicit flag opts in.
- Live view, approval prompts, and interactive patch previews render to stderr.
- Non-interactive stdout remains reserved for the final Session summary. Interactive `forge write` may suppress replaying final prose that already streamed and show only compact artifact/Trace handles.
- Trace files do not gain fake progress, spinner, waiting, or token-delta events.

Suggested TDD path:

1. Add focused tests for `formatSessionLiveEvent(...)` in a new `tests/sessionLiveView/sessionLiveView.test.ts`.
2. Add workflow-level tests proving `runWorkflowSession` emits the minimal event sequence for:
   - a read-only coding Session with a tool call
   - an actionable coding Session with approval and command execution
   - a writing Session with only model turns
   - a stopped or failed Session
3. Add CLI integration coverage proving:
   - injected live sink receives events without changing `RunCliResult.stdout`
   - non-interactive default output remains unchanged
   - approval prompt and patch preview can be routed to stderr in terminal mode
4. Implement `src/sessionLiveView/index.ts`.
5. Thread `onLiveEvent` through `runAgent` into `runWorkflowSession`.
6. Emit events at the runner boundaries, not by tailing Trace files.
7. Add a CLI terminal renderer used by the real entrypoint and injectable in tests.
8. Move terminal approval prompt and patch preview output from stdout to stderr.
9. Run `npm test` and `npm run typecheck`.

Implementation notes:

- Prefer structured event fields over preformatted strings at the runner boundary.
- Keep formatter output concise and stable enough for integration tests.
- Tool-call events should include tool name and a short target summary when available, but should not print full tool input by default.
- Command events should include command text, exit code, and timeout status.
- Failure events should include the recorded Session failure or stop reason when available.

### Slice 2: Provider Model Output Stream

Add provider-level text chunk streaming after Slice 1 is stable.

Acceptance criteria:

- DeepSeek streaming can emit real text deltas into the Session Live View.
- Model Output Stream does not replace Session Live View and does not cover tool execution, approval, or command execution.
- Token or chunk deltas are not persisted as ordinary Trace events.
- Existing non-streaming tests remain deterministic, with fake-model coverage for streaming behavior.

## Open Questions For Implementation

- Whether to add an explicit future flag such as `--live-view=auto|always|off`.
- Whether stderr rendering should include lightweight indentation or plain one-line events only.
- Whether a later verbose mode should include budget updates, compaction, plan updates, and read metadata.
