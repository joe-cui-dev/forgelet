# Forgelet Model Output Stream Handoff

## Next Session Focus

The user says CLI Session Live View is already complete and wants the next agent session to start with `$grill-me` for the next slice: **Model Output Stream**.

Use this handoff to run a focused design grilling session before implementation. Do not rehash the completed Session Live View design except where it constrains streaming.

## Suggested Skills

- `$grill-me`: Primary skill for the next session. Grill the Model Output Stream design one decision at a time, present alternatives, compare them, and recommend one.
- `$grill-with-docs`: Use if the grilling resolves new canonical terms, roadmap updates, or an ADR-worthy streaming decision.
- `$tdd`: Use after the grilling session if the user says to start implementation.
- `$diagnose`: Use if provider streaming introduces hangs, partial-response bugs, or trace/read-model regressions.

## Existing Source Of Truth

Do not duplicate these artifacts; reference them:

- Glossary:
  - `/Users/xiaozhoucui/repos/forgelet/CONTEXT.md`
  - Terms already defined: `Session Live View`, `Model Output Stream`, `Trace`, `Active Context`.
- Roadmap:
  - `/Users/xiaozhoucui/repos/forgelet/FORGELET_LONG_TERM_PLAN_V2_V3.md`
  - V2 Issue 9 states that Session Live View comes before provider-level Model Output Stream.
- ADR:
  - `/Users/xiaozhoucui/repos/forgelet/docs/adr/0015-cli-session-live-view-is-presentation.md`
  - Key constraint: live presentation is not Trace evidence; stdout remains final-summary-only while interactive progress goes to stderr.
- Prior execution plan:
  - `/Users/xiaozhoucui/repos/forgelet/docs/cli-session-live-view-execution-plan.md`
  - Slice 2 is the relevant section: Provider Model Output Stream.

## Current Code Shape To Inspect First

Start from these files:

- `/Users/xiaozhoucui/repos/forgelet/src/sessionLiveView/index.ts`
  - Defines `SessionLiveEvent`, `SessionLiveEventSink`, and terminal formatting.
  - Current events cover Session lifecycle, trace path, model turn start/finish, tool calls, permissions, commands, and Session finish.
  - There is no model text delta event yet.
- `/Users/xiaozhoucui/repos/forgelet/src/types.ts`
  - `ModelClient` currently has `createTurn(input: ModelTurnInput): Promise<ModelTurnOutput>`.
  - `ModelTurnInput` currently has `task`, `messages`, and `tools`.
  - There is no streaming callback in `ModelTurnInput` or `ModelClient`.
- `/Users/xiaozhoucui/repos/forgelet/src/models/providers/deepseek.ts`
  - `DeepSeekModelClient.createTurn()` currently sends `stream: false`.
  - `DeepSeekChatRequest.stream` is typed as `false`.
  - `postJsonWithHttps(...)` posts JSON and waits for `readDeepSeekResponse(...)`.
  - `readDeepSeekResponse(...)` currently buffers all response chunks, parses JSON on `end`, and has careful aborted/error handling.
- Tests to inspect:
  - `/Users/xiaozhoucui/repos/forgelet/tests/sessionLiveView/sessionLiveView.test.ts`
  - `/Users/xiaozhoucui/repos/forgelet/tests/agent/readOnlySessionLoop.test.ts`
  - `/Users/xiaozhoucui/repos/forgelet/tests/cli/cliIntegration.test.ts`
  - `/Users/xiaozhoucui/repos/forgelet/tests/models/deepSeekProvider.test.ts`

## Decisions Already Made

- Model Output Stream is narrower than Session Live View.
- Model Output Stream is real provider text emitted during a model turn.
- It does not cover tool execution, approval decisions, command execution, or other Agent Kernel events.
- It must not replace Session Live View.
- Token/chunk deltas should not be persisted as ordinary Trace events.
- The first implementation should happen after Session Live View is stable.
- Keep deterministic fake-model tests for kernel behavior; reserve live DeepSeek calls for smoke/integration checks.
- Streaming should enter the provider-agnostic model boundary as an optional callback on `ModelTurnInput`, such as `onOutputDelta?: (delta: ModelOutputDelta) => void | Promise<void>`.
- `ModelClient.createTurn()` should remain the single model-call method and still return a complete `ModelTurnOutput` assembled from the provider response.
- Model text deltas should enter the live presentation surface as structured `SessionLiveEvent` values, not direct terminal writes.
- The first live event shape should be a single `model_output_delta` event with `turnIndex`, `model`, and `text`; `model_turn_started` and `model_turn_finished` remain the lifecycle events.
- The terminal Session Live View should render `model_output_delta.text` directly to stderr without adding a per-delta prefix or newline.
- The terminal sink should track whether the previous write was an unterminated model output delta and insert one newline before the next non-delta live event when needed, so streamed text does not visually merge with later progress lines.
- Tool-call deltas should not enter Session Live View. Provider-specific partial tool-call JSON should stay inside the provider parser until it can be assembled into complete `ModelToolCall` values.
- The Agent Kernel should continue to receive tool calls only through final `ModelTurnOutput.toolCalls`, preserving the existing permission, tool execution, Trace, and audit flow.
- Streaming usage and cost should come only from provider-reported final usage metadata when the streaming response includes it.
- Forgelet should not locally estimate usage from streamed text and should not issue a second non-streaming request just to recover usage. If streaming usage is absent, `ModelTurnOutput.usage` remains `undefined` and the existing budget update path treats that turn as a zero usage increment.
- Streaming fallback is only acceptable before a streaming provider response has started, such as when streaming is disabled or known to be unsupported.
- Once a streaming response has begun, provider errors, aborts, invalid stream frames, or incomplete final data should fail the model turn through the existing provider diagnostics path. Forgelet should not retry non-streaming automatically and should not return partial streamed content as a complete `ModelTurnOutput`.
- Streaming should follow the interactive Session Live View path by default: when the CLI enables Session Live View, the workflow runner should pass an output-delta callback and providers may use streaming.
- Non-interactive runs, runs without a live-event sink, and script-oriented output should continue using the existing non-streaming provider path by default. Do not add a separate `--stream` flag in the first slice.
- The first implementation should be one complete vertical slice across the provider-agnostic contract, live event, terminal sink, workflow bridge, DeepSeek SSE parser, and CLI integration. Keep the tests layered so kernel/live-view behavior can still be verified with deterministic fakes before exercising provider parsing.
- Do not create a new ADR for the first Model Output Stream slice. ADR 0015 already records the durable presentation-vs-Trace decision; these streaming decisions should stay in this handoff unless later provider experience reveals a harder architectural trade-off.
- Final validation should include `npm test`, `npm run typecheck`, and one narrow real DeepSeek dogfood Session. The dogfood should confirm streamed model text appears on stderr, stdout remains reserved for the final Session summary, and the project-local Trace does not persist `model_output_delta` or other token-delta dump events.

## Grill-Me Topics For The Next Session

Ask one question at a time. For each question, present options, compare them, and recommend one.

Recommended first questions:

1. **Where should streaming enter the internal model API?**
   - Option A: add `onOutputDelta` or similar to `ModelTurnInput`.
   - Option B: add a second `createStreamingTurn(...)` method to `ModelClient`.
   - Option C: keep `ModelClient` non-streaming and make DeepSeek-specific streaming live only in CLI/provider glue.
   - Likely recommendation to test: add a provider-agnostic optional callback to `ModelTurnInput`, because the runner already owns model turns and can bridge deltas into Session Live View.

2. **What live event type should represent text deltas?**
   - Option A: extend `SessionLiveEvent` with a generic `model_output_delta`.
   - Option B: add separate `model_output_started`, `model_output_delta`, `model_output_finished`.
   - Option C: keep deltas outside `SessionLiveEvent` and stream directly to terminal.
   - Likely recommendation to test: keep deltas as structured live events so future UI can reuse them, but do not write them to Trace.

3. **How should text deltas render in the terminal?**
   - Option A: print raw deltas inline after `Model turn N started`.
   - Option B: print deltas in a clearly labelled final-answer block only when there are no tool calls.
   - Option C: buffer deltas for display but still show regular Session Live View lines.
   - Key tension: raw deltas make the model feel alive, but tool-call turns may emit partial reasoning or text before tool calls. Avoid confusing final answer with interim model text.

4. **How should tool-call streaming be handled?**
   - DeepSeek may stream tool-call structure differently from final text. The next agent should verify provider docs or current API behavior before deciding.
   - The product goal is text visibility, not partial tool-call JSON visibility.
   - Consider buffering tool-call deltas until the complete `ModelToolCall` can be converted into normal Forgelet tool-call events.

5. **How should usage/cost be handled in streaming responses?**
   - Current cost estimation relies on final response `usage`.
   - Decide whether streaming needs an explicit final usage event/parse path or falls back to unavailable usage.
   - Preserve existing budget behavior as much as possible.

6. **What is the fallback path?**
   - If streaming is unavailable, invalid, interrupted, or disabled, Forgelet should still complete through the existing non-streaming `createTurn()` path or fail with the same provider diagnostics.
   - Avoid regressing the recent DeepSeek aborted-response handling.

7. **Should streaming be default or opt-in?**
   - Prior direction suggests Model Output Stream is a follow-up enhancement to Session Live View.
   - Grill whether interactive TTY runs should stream text by default once implemented, or whether a flag/config should guard it initially.

## Implementation Constraints To Preserve

- stdout remains reserved for the final Session summary.
- interactive progress and streaming presentation should go to stderr unless a later design explicitly changes that contract.
- Trace must remain evidence-first and should not become a token-delta dump.
- Final `ModelTurnOutput` must still be assembled for the workflow loop, because tool-call execution, final-answer detection, usage, and audit logic depend on it.
- Session Live View events should remain useful even when the provider emits no text deltas.
- Streaming should not make unit tests depend on the live provider.
- The DeepSeek aborted/partial response error path is important; do not loosen it while adding SSE parsing.

## Likely Implementation Files

- `src/types.ts`
- `src/sessionLiveView/index.ts`
- `src/models/providers/deepseek.ts`
- `src/models/testing/index.ts`
- `src/workflows/index.ts`
- `src/agent/runAgent.ts`
- `src/cli/index.ts`
- `tests/models/deepSeekProvider.test.ts`
- `tests/sessionLiveView/sessionLiveView.test.ts`
- `tests/agent/readOnlySessionLoop.test.ts`
- `tests/cli/cliIntegration.test.ts`

## Validation Shape

After design decisions are locked, likely validation should include:

- deterministic unit tests for streaming event formatting
- fake-model or fake-provider tests proving deltas are emitted without changing Trace events
- DeepSeek provider tests for streamed text chunks, final assembled `ModelTurnOutput`, tool-call buffering if supported, HTTP error, invalid stream, and aborted stream
- workflow test proving a streamed final answer still completes normally
- CLI test proving stdout remains final summary while stderr receives live/stream output
- `npm test`
- `npm run typecheck`

## Current Repo Note

At the time of this handoff, `git status --short` showed only an unrelated untracked `temp.md` in the workspace. Do not delete or modify it unless the user explicitly asks.

## Sensitive Information

No API keys, tokens, passwords, or personal credentials are included in this handoff. Do not print or persist provider API keys while working on streaming.
