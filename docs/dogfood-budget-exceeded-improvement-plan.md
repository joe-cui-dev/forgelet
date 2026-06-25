# Dogfood Budget Exceeded Improvement Plan

## Context

Two real actionable dogfood Sessions stopped with `budget_exceeded` before producing a useful completed result:

- `sess_mqp5ea9f`: the model spent 8 turns reading many files, reached `139095/120000` input tokens, and stopped at an estimated cost of only `$0.0593/$0.25`.
- `sess_mqp5vqc1`: the prompt was narrowed to a tiny README improvement, but the model still reached `137560/120000` input tokens at `$0.0607/$0.25`. It requested `apply_patch`, the user approved it, and the patch then failed `git apply --check` with `corrupt patch at line 13`.

The user-facing symptom is confusing because `--budget 0.25` reads like a dollar budget, but the stopped reason is also used for input-token exhaustion.

There is also a trace-correlation concern: the reported command for `sess_mqp5vqc1` was about improving the stopped Session summary, but the `user_task` recorded in that trace is the narrower README wording task. Dogfood diagnosis needs an easy way to confirm that the Session ID being inspected belongs to the command the user just ran.

## Findings

### 1. `budget_exceeded` hides the actual exhausted limit

`budgetStopReason` returns `budget_exceeded` when either `usage.inputTokens >= limits.maxInputTokens` or `usage.estimatedCostUsd >= limits.maxEstimatedCostUsd`. The stopped summary only prints:

```text
Reason: budget_exceeded
Model turns: 8
```

It does not print input tokens, output tokens, estimated cost, or which limit fired.

### 2. Budget is checked before model turns, not before tool execution

The loop checks the budget at the start of a turn. After a model turn returns, usage is updated and `budget_update` is traced, but tool calls from that already-over-budget turn are still executed.

In `sess_mqp5vqc1`, the model turn pushed input tokens over the limit and then requested `apply_patch`. Forgelet still asked the user for approval, then attempted the patch, then stopped. That makes the approval feel wasted and makes the Session outcome harder to reason about.

### 3. `read_file` only supports first-chunk reads

`read_file` always returns the first 20KB of a file. It has no `offset`, `lineStart`, `lineCount`, `head`, or `tail` mode.

In `sess_mqp5vqc1`, the model said it needed the tail of `src/workflows/index.ts`, but repeated `read_file` calls returned the same first 20KB. This increased context without adding useful information.

### 4. Tool observations accumulate full returned content in the model conversation

Trace payloads correctly omit full file content, but the active model conversation includes the full `read_file` observation content. Repeated reads of large files cause the next model input to grow quickly.

### 5. Natural-language constraints are not enforceable enough

The prompt said to inspect only `README.md` and `src/workflows/index.ts`, but the model also read `docs/adr/0012-traces-record-real-session-events.md` and `src/types.ts`. That may be understandable, but it shows that prompt-only task scoping is weak for dogfood runs.

### 6. Patch failure could not be recovered

The model produced a corrupt patch after the turn had already exceeded the input-token limit. Because Forgelet stops before the next model turn, the model never saw the failed patch observation and could not retry with a smaller valid patch.

### 7. Session-to-command correlation is too easy to lose

The `sess_mqp5vqc1` trace records a different task string than the command reported during diagnosis. That may mean the wrong Session ID was inspected, or that CLI output/history made it too easy to mix up adjacent dogfood runs.

## Recommended Slices

### Slice 1: Make stopped summaries diagnostic

Goal: after a stopped Session, the user can tell exactly which limit fired without opening the JSONL trace.

Changes:

- Split the stop reason into more specific values, for example:
  - `max_model_turns`
  - `input_token_limit_exceeded`
  - `estimated_cost_budget_exceeded`
- Include budget details in `formatStoppedSummary`:
  - model turns used and limit
  - input tokens used and limit
  - output tokens used
  - estimated cost used and limit
- Fully replace the old `budget_exceeded` value rather than preserving legacy trace compatibility. Forgelet is still experimental, and future dogfood Sessions should validate the new explicit reasons.

Validation:

- Add a deterministic test where input tokens exceed `maxInputTokens` while estimated cost stays below `maxEstimatedCostUsd`.
- Assert the final summary names `input_token_limit_exceeded` and prints `Input tokens: used/limit`.
- Run `npm test`.

### Slice 2: Stop over-budget turns before executing tool calls

Goal: do not ask the user to approve or execute durable actions after the model has already exceeded a hard budget limit.

Changes:

- After each `model_turn` and `budget_update`, re-check token and cost limits before executing tool calls.
- If the turn exceeded a hard budget and returned tool calls:
  - trace a stopped Session with the precise reason
  - do not execute the tool calls
  - trace a `budget_blocked_tool_calls` event that records the stop reason, skipped count, and tool names without recording full tool arguments
  - include a summary line such as `Skipped 1 tool call because the input token budget was exceeded.`
- Keep `max_model_turns` as a before-next-turn check.

Validation:

- Add a test where a fake model returns an `apply_patch` tool call with usage that exceeds `maxInputTokens`.
- Assert no `tool_call`, `permission_decision`, or `approval_decision` is traced for that over-budget tool call.
- Assert the workspace is unchanged.

### Slice 3: Add targeted file reads

Goal: let the model inspect the relevant part of a file without repeatedly paying for the same first chunk.

Changes:

- Extend the existing `read_file` tool rather than adding a separate tail tool.
- Keep the default `{ path }` behavior as the first chunk, and add mutually exclusive targeting modes:
  - byte range: `offsetBytes` and optional `limitBytes`
  - line range: `startLine` and `lineCount`
  - tail range: `tailLines`
- Treat conflicting targeting modes as `invalid_input`, but handle out-of-range reads leniently by returning the available content and accurate range metadata.
- Use 1-based line numbers for line ranges, return raw file content without line-number prefixes, and put the actual returned line range in metadata.
- Treat byte ranges as exact byte slices; source-code inspection should prefer line ranges, while byte ranges are mainly for continuing after a truncated chunk.
- Keep the existing 20KB model observation limit across all modes; requested byte, line, or tail ranges may be clipped to that limit and reported through metadata.
- Record enough range metadata for the model to continue without repeating content, including `rangeKind`, requested range fields, actual returned range fields, `returnedBytes`, `totalBytes`, `truncated`, `contentHash`, and `nextOffsetBytes` for default/byte reads.
- Include returned range metadata in both model observation and trace metadata.
- Update the `read_file` tool description with the range-use strategy: default reads the first chunk, `offsetBytes: metadata.nextOffsetBytes` continues after truncation, 1-based `startLine`/`lineCount` reads a source range, `tailLines` reads the end of a file, and range modes are mutually exclusive.

Validation:

- Add tests for first chunk, later byte range, line range, and tail reads.
- Add a test proving repeated tail requests do not return the same first chunk.

### Slice 4: Bound active model context

Goal: keep the active model conversation bounded during multi-turn Sessions without turning V1 into an intelligent context-management system.

V1 scope:

- Implement the deterministic algorithm in `src/conversation/compaction.ts`; keep `src/workflows/index.ts` responsible only for invoking it before a model turn, writing the aggregate Trace event, and exposing the optional prompt status.
- Apply the rule in the Agent Kernel to tool observations from any Workflow. Do not special-case Coding, but do not compact system/user prompt content, Context Attachments, or Durable Memory in Slice 4.
- Expose the mutation explicitly as `compactConversationInPlace(conversation, options): CompactionResult`. Its only permitted conversation mutation is replacing the `content` of eligible tool messages; it must not add, remove, or reorder messages, change `toolCallId`, or alter assistant `toolCalls`. Return aggregate statistics separately for Trace and prompt status.
- Add a deterministic Agent Kernel compaction pass before each model turn.
- Run the pass once immediately before `buildMessages` / `modelClient.createTurn`. Skip it when the conversation contains no tool observations. Do not compact incrementally while results from one assistant tool-call turn are still being appended.
- Give tool observations in the active conversation their own internal `active observation byte budget`, distinct from the cumulative `maxInputTokens` Session limit.
- Measure that budget using the UTF-8 byte length of model-visible tool observation messages. Do not label this value as tokens: it is a deterministic V1 guardrail for the content Forgelet directly controls, not an estimate of the provider's complete model input.
- Keep Slice 4 observation-only. Do not rewrite historical assistant tool-call arguments, including `apply_patch` inputs, and do not claim `activeContext.maxObservationBytes` bounds the complete provider prompt. Evaluate historical tool-call argument compaction separately if actionable dogfood shows large patch arguments materially inflate later turns.
- Make the active observation byte budget configurable as `activeContext.maxObservationBytes` in `.forgelet/config.json`, defaulting to `16384` bytes when the project does not specify it. Keep it separate from `budgets`, because it bounds the model's active working set rather than defining a Session stop condition. The initial 49152-byte candidate still allowed the baseline dogfood task to reach `131976/120000` cumulative input tokens; a 16384-byte dogfood run reduced cumulative input to `84254` across 12 turns and moved the remaining failure to the separate model-turn limit. Tests may inject a deliberately small value to exercise compaction deterministically.
- Merge `activeContext` through the existing configuration precedence: built-in defaults, then `~/.forgelet/config.json`, then project `.forgelet/config.json`. The project value wins; Slice 4 must not introduce a separate configuration-loading path.
- Extend the existing global command to accept `forge config set activeContext.maxObservationBytes <integer>`. Keep its current global-write semantics; project-specific overrides remain manual edits to `.forgelet/config.json`, and Slice 4 does not add a `--project` config mutation command.
- Validate `activeContext.maxObservationBytes` during configuration loading. It must be a finite integer of at least `4096`; otherwise fail before the first model call with an error that names the invalid field. Do not silently fall back or clamp an explicitly invalid value.
- Normally keep complete tool content for every observation produced by the newest assistant tool-call turn, and compact older observations oldest-first when the active conversation exceeds its budget.
- Preserve every observation from the newest assistant tool-call turn until the model has received that complete batch once, even when the batch temporarily exceeds `activeContext.maxObservationBytes`. Before a later model turn, that batch becomes eligible for normal deterministic compaction. This fresh-batch rule supersedes the earlier fallback that protected only the newest and last failed observations.
- Compact observations in deterministic tiers, oldest-first within each tier:
  - first, old `read_file`, `git_diff`, and `run_command` observations
  - then, other old tool observations if the conversation is still over budget
  - finally, observations from the newest tool-call turn only under the newest-turn fallback rule
- Preserve tool-call identity and assistant/tool message ordering so provider message contracts remain valid.
- Replace compacted observations with deterministic metadata already available to the kernel, such as tool name, summary, path, content hash, returned range, truncation state, and command result. Reuse `metadata.preview` when present, clipped to at most 512 UTF-8 bytes; if no preview exists, retain only the summary and metadata. The compactor must not reread files or derive a new excerpt from discarded full content.
- Build compact metadata from an explicit kernel allowlist rather than spreading the entire source metadata object. The V1 allowlist covers path, content hash, requested and returned range fields, byte/line counts, truncation and continuation state, changed files, command, exit code, duration, timeout state, and preview. Unknown or future metadata fields are discarded until deliberately added to the compact contract.
- Replace eligible tool messages in the in-memory `conversation` in place. Do not retain a second hidden copy of discarded full observation content. The immutable Trace remains the execution evidence; if the model later needs file details again, it can issue a targeted read using the retained path and range metadata.
- Mark the compact model-visible observation explicitly with `compacted: true`. Later compaction passes must treat that marker as authoritative and skip the message, rather than inferring compaction from a missing `content` field. Preserve `ok`, `toolCallId`, `toolName`, `summary`, relevant error information, and compact metadata.
- If a tool message is not valid JSON or does not match the expected model-visible observation shape, leave it unchanged and increment `uncompactableCount`. Do not fail the Session or truncate an unknown payload heuristically.
- Protect failed observations as part of the complete fresh observation batch. Once a later tool-call turn exists, they become eligible for normal tiered compaction; their compact form must retain the complete structured `error.code`, `error.message`, and summary even when large content is discarded.
- Give `apply_patch` observations no permanent exemption. Protect them under the same newest-turn and failure rules, then allow old patch observations to compact while retaining `changedFiles`, patch validation outcome, summary, and complete structured errors. The model should use `git_diff` when it later needs the concrete resulting diff.
- For `run_command`, V1 compaction must consume only the existing summary, command, exit code, timeout state, structured error, and available preview. Do not expand Slice 4 to redesign command observations with separate stdout/stderr or head/tail previews; treat that as a later tool-contract improvement if dogfood shows the compact result is insufficient.
- Treat `activeContext.maxObservationBytes` as a best-effort working-set target, not a new Session stop limit. If every eligible observation has reached its compact form and their combined size still exceeds the target, preserve those minimum facts, continue the Session, and record the residual overage in compaction Trace metadata. Do not delete complete assistant/tool exchanges or introduce an `active_context_limit_exceeded` stop reason in V1.
- Before a model call, emit at most one aggregate compaction Trace event. Use `conversation_compacted` when at least one observation changed. If the conversation exceeds the target but no observation can be changed, use `conversation_compaction_attempted` instead. Both events record `compactedCount`, `uncompactableCount`, `beforeObservationBytes`, `afterObservationBytes`, `targetObservationBytes`, unique `toolNames`, and `residualOverageBytes`. Do not record paths, previews, removed content, or one event per observation, and do not rewrite earlier Trace events.
- Only when the immediately preceding compaction pass changed observations, add a short status line to the next model prompt such as `Active observations compacted: 30124/49152 bytes.` Do not show this line on unaffected turns, and do not describe the byte values as tokens.
- Extend `forge explain <sessionId>` to summarize compaction evidence from aggregate Trace events, including pass count, total compacted observations, cumulative bytes removed, and maximum residual overage. Calculate cumulative bytes removed as the sum of `beforeObservationBytes - afterObservationBytes` for each event; a no-change attempted event contributes zero. Keep `forge sessions show` unchanged; compaction is diagnostic execution evidence rather than a primary Session summary field.
- Keep model-generated summaries, semantic relevance scoring, explicit observation pinning, and resumed-Session reconstruction in the V2 `Conversation Compaction and Context Budgeting` work.

Validation:

- Add focused compactor unit tests for deterministic tier ordering, complete fresh-batch protection, later eligibility of that batch, idempotence through `compacted: true`, and residual overage after every eligible observation reaches compact form.
- Add one workflow-level fake-model integration test that reads multiple large files, crosses a deliberately small configured observation budget, and then completes a representative inspect-and-summarize task.
- Assert later model inputs respect the best-effort observation target when compact forms make that possible.
- Assert compacted tool messages retain their original `toolCallId` and remain paired with the corresponding assistant tool calls.
- Assert configuration loading and `forge config set activeContext.maxObservationBytes <integer>` accept valid values and fail fast for invalid values.
- Confirm Trace still omits full content and records at most one aggregate `conversation_compacted` or `conversation_compaction_attempted` event per pre-turn pass with only the approved metadata.
- Add an explanation read-model test proving `forge explain` aggregates compaction events without requiring compacted prompt content.

Dogfood acceptance:

1. Run a live read-only Coding Workflow Session that inspects and summarizes the CLI entrypoint. Confirm it completes without rapidly exhausting cumulative input tokens, emits compaction evidence when the observation target is crossed, and returns an accurate summary.
2. Run a live actionable Coding Workflow Session with `--act` that makes one tiny low-risk change and runs a configured verification command. Confirm compaction does not break tool-call pairing, approval, patching, verification, final audit, or `forge explain`.

The original `sess_mqrxs591` command used `--live` without `--act`, so it is the read-only baseline for phase 1 rather than an actionable Session.

Implementation dogfood results:

- With the initial 49152-byte default, `sess_mqs258i7` compacted 14 observations and removed 109240 model-visible bytes, but still stopped at `131976/120000` cumulative input tokens.
- With the calibrated 16384-byte target, `sess_mqs277py` and the default-value confirmation `sess_mqs29bfq` stayed below the input limit at `84254/120000` and `82262/120000`. Both instead reached `max_model_turns`, showing that compaction fixed the demonstrated input-growth failure while exposing a separate model stopping-discipline problem.
- Actionable Sessions `sess_mqs2aont` and `sess_mqs2dvle` also stayed below the input limit. Permission policy correctly denied editing a path dirty at Session start, configured typecheck completed successfully when approved, and compaction evidence remained explainable. The model nevertheless exhausted its turn budget after repeated reads, corrupt patch attempts, and duplicate patch requests.
- Slice 7 defines the immediate follow-up for newest-batch visibility and final-turn behavior. Duplicate action detection and patch-generation recovery remain separate later concerns.

### Slice 5: Make dogfood task scope enforceable

Goal: support narrow dogfood runs without relying only on prompt wording.

Changes:

- Add an optional per-Session `Session Read Scope` that narrows which workspace content the Session's read capabilities may expose.
- Enforce the scope across all tools that expose workspace content, not only `read_file`.
- Keep `read_workspace` as the Workflow Capability Grant; apply the narrower Session boundary through the Permission Policy.
- If a model requests content outside the Session Read Scope, return a controlled `permission_denied` observation and trace the real permission decision.
- Keep write scope outside Slice 5; workspace mutations continue through their existing capability and permission rules.
- Define scope entries as workspace-relative file or directory paths. A file entry allows only that file; a directory entry recursively allows its descendants.
- Keep V1 matching literal and do not support globs.
- Resolve and compare real paths so symlinks cannot expose content outside an allowed entry or the workspace.
- For collection reads such as `list_files` and `search_text`, allow requests whose target overlaps the Session Read Scope, but traverse and return only allowed files.
- Do not reveal the names or existence of excluded paths. Mark successful filtered observations as constrained by the Session Read Scope.
- Apply the Session Read Scope to `git_status` and `git_diff` even though they use the separate `git_read` Capability, because both can expose workspace paths or file content.
- Filter Git observations to allowed files only, mark them as scope-constrained, and do not report excluded file names or counts.
- Do not apply the Session Read Scope to explicit Context Attachments supplied through `--context`. Those are user-authorized Session inputs, while the scope limits subsequent workspace exploration through tools.
- Attaching one file does not implicitly add that file or its directory to the Session Read Scope.
- Add a repeatable `--allow-read <workspace-relative-path>` CLI option. One or more occurrences form the Session Read Scope for that run.
- When `--allow-read` is absent, preserve the current unrestricted workspace-read behavior. The scope is per-Session and is not persisted to global or project configuration.
- Normalize and validate scope entries before the first model call, then record the normalized entries in the `session_started` Trace event so the enforced boundary is auditable.
- Pass the Session Read Scope through the Session and tool context rather than storing it as mutable global state.

Example:

```bash
forge --live \
  --allow-read README.md \
  --allow-read src/workflows \
  "Summarize the workflow"
```

Validation:

- Add CLI parser and integration tests for repeated `--allow-read` values, missing values, and the unrestricted behavior when the flag is absent.
- Add a test where `read_file` for an allowed path succeeds and a disallowed path returns a denial.
- Add coverage proving other workspace-reading tools cannot expose content outside the Session Read Scope.
- Add tests for recursive directory entries, literal non-glob matching, and symlink escape denial.
- Add tests proving collection reads return only allowed paths and do not reveal excluded path names.
- Add tests proving `git_status` and `git_diff` expose only allowed paths and content.
- Add a test proving an explicit Context Attachment remains available outside the Session Read Scope without granting tool access to its path.
- Confirm denied reads are traced as real permission decisions.
- Confirm `session_started` records normalized scope entries and no scope field is emitted as an implied restriction when `--allow-read` is absent.

Implementation result:

- Slice 5 is implemented with repeatable `--allow-read`, normalized per-Session scope state, Permission Policy denials for direct and disjoint collection reads, and scope-filtered workspace and Git observations.
- Context Attachments remain independent user-authorized inputs, and real-path checks prevent symlink escapes.
- Automated coverage includes unrestricted compatibility, allowed and denied reads, recursive directories, literal paths, collection filtering, Git filtering, missing targets, Context Attachments, and symlink boundaries.

### Slice 6: Make Session correlation obvious

Goal: make it hard to diagnose the wrong Session after several dogfood runs.

Changes:

- Print the Session ID and trace path prominently at Session start and finish.
- Add a short `taskHash` to `session_started`, CLI output, and `forge sessions list`.
- Generate `taskHash` from a normalized `user_task` by trimming, normalizing whitespace, hashing the result, and displaying a short stable prefix such as 8 hex characters.
- Treat `taskHash` as diagnostic metadata only. The Session ID remains the identity boundary; the hash helps humans confirm that the inspected Session belongs to the command they just ran.
- Consider printing the first line of the task next to the Session ID immediately when a run starts.

Validation:

- Add a CLI integration test that asserts live/scaffolded runs print the Session ID, trace path, and task hash.
- Confirm `forge sessions list` exposes enough information to match a command to a trace without opening JSONL.

### Slice 7: Preserve fresh observations and reserve a final answer turn

Goal: prevent small Sessions from exhausting `maxModelTurns` through repeated exploration when the required evidence has already been gathered.

Changes:

- Treat all observations produced by one assistant tool-call turn as one fresh observation batch.
- Preserve the complete fresh batch through the immediately following model turn, even when that temporarily exceeds `activeContext.maxObservationBytes`.
- After that following model turn completes, the batch becomes eligible for normal deterministic compaction before a later model turn.
- Apply the same one-turn protection to successful, failed, and denied observations. Do not retain a separate long-lived failed-observation exemption.
- Keep `activeContext.maxObservationBytes` as a best-effort working-set target. A fresh-batch overage is recorded through the existing compaction evidence and is not a new Session stop condition.
- Keep the existing per-tool observation truncation as the V1 guardrail against unusually large individual results. Do not add an emergency fresh-batch compactor or tool-call-count limit in this slice.
- Interpret `maxModelTurns` as including one reserved final answer turn for every Workflow using the Agent Kernel.
- When two turns remain, keep tools available but tell the model this is its final tool-capable turn and it should request only the operations still required to finish.
- When one turn remains, expose no tools and explicitly require final content based on the evidence already available.
- A configuration of `maxModelTurns: 1` therefore permits one direct-answer turn and no exploratory tool turn.
- Do not run the reserved final answer turn if input-token or estimated-cost limits have already been reached. Those remain hard limits and retain their precise stop reasons.
- Record `finalOnly: true` on the real `model_turn` Trace event for the reserved final answer turn.
- A final answer is complete only when the model returns non-empty content with no tool calls.
- If the reserved final answer turn returns tool calls, do not execute them. Record `budget_blocked_tool_calls` with reason `max_model_turns`, then stop the Session with `max_model_turns`.
- If the reserved final answer turn returns empty content, stop with `max_model_turns`; do not synthesize a result that the model did not produce.
- Apply the rule uniformly to Coding and Writing Workflows. Workflow-specific final output formatting remains unchanged.

Validation:

- Replace the current newest-turn fallback compactor test with coverage proving every observation in the newest assistant tool-call batch remains complete for the next model turn, including when the batch exceeds the observation target.
- Add coverage proving that batch becomes compactable before a subsequent model turn.
- Add a workflow test where a multi-tool batch crosses the target, remains fully visible once, and then the Session completes without rereading the same evidence.
- Replace the current `maxModelTurns: 1` expectation with a direct-answer test proving the sole turn receives no tools and can complete.
- Add a test proving the penultimate turn receives tools plus a final-tool-turn warning.
- Add a test proving the reserved final answer turn receives no tools, is traced with `finalOnly: true`, and can complete with non-empty content.
- Add tests proving tool calls or empty content on the reserved turn stop with `max_model_turns` and do not execute tools.
- Add a test proving an exhausted input-token or cost limit prevents the reserved turn and keeps its precise stop reason.
- Run `npm test`, `npm run typecheck`, and a live read-only dogfood retry of the CLI-entrypoint summary task.

Dogfood acceptance:

- The CLI-entrypoint summary task completes with an accurate final answer instead of stopping after a twelfth read.
- A fresh parallel read batch is visible in full exactly once before it becomes compactable.
- The final Trace shows a `finalOnly: true` model turn with no executed tool calls.
- The change does not raise the default `maxModelTurns` above 12.

Implementation result:

- The Agent Kernel now preserves the complete newest observation batch through one model turn, then makes it eligible for normal deterministic compaction.
- The last available model turn is reserved for a non-empty final answer, exposes no tools, and records `finalOnly: true`. The preceding turn remains tool-capable and receives an explicit final-tool-turn warning.
- Final answer synthesis receives prior evidence as plain text rather than replaying the assistant/tool protocol. This prevents DeepSeek from continuing its tool-calling mode merely because historical tool messages remain in context.
- Tool calls returned on the final-only turn are blocked without execution. Empty output and DeepSeek textual DSML tool-call markup are not accepted as completed results.
- `maxModelTurns: 1` now means one direct-answer turn with no tools. Input-token and estimated-cost limits remain hard stops checked independently.
- Automated validation passes with the default `maxModelTurns` still set to 12.

Dogfood result:

- `sess_mqtcfzst` completed the original CLI-entrypoint summary task in 12 turns. Its final turn recorded `finalOnly: true`, exposed no tools, and produced prose instead of DSML tool-call markup.
- The completion mechanism passed, but answer-quality acceptance remains partial: the suggested `--help` improvement was incorrect because `src/cli/parseArgs.ts` and `src/cli/index.ts` already support the help command.
- Earlier retries `sess_mqtc9gh1`, `sess_mqtcbv63`, and `sess_mqtcdmtu` demonstrated that removing tool schemas alone was insufficient for DeepSeek; historical assistant/tool protocol caused textual DSML tool requests. Those Sessions are now stopped honestly rather than being misreported as completed.
- Improving evidence relevance, duplicate-read suppression, and final-answer factual review remains separate follow-up work. It should not weaken fresh-batch protection or expand `maxModelTurns`.

## Recommended Order

1. Slice 1 first. It is the smallest user-visible improvement and gives better diagnostics for every later dogfood run.
2. Slice 2 second. It removes the worst UX from `sess_mqp5vqc1`: approval after the budget was already exceeded.
3. Slice 3 third. It addresses the biggest token-growth cause in the traces.
4. Slice 4 fourth. Implement the deterministic V1 active-context bound now that targeted read metadata is available; keep semantic compaction and resume integration in V2.
5. Slice 5 later. It is useful for dogfood harnessing, but it expands the permission surface and should not block the first fixes.
6. Slice 6 can be done anytime. It is small and improves every future dogfood diagnosis.
7. Slice 7 next after the completed compaction work. It addresses the max-turn failure exposed by live validation without widening the Session budget.

## Next Dogfood Command After Slice 1 and Slice 2

```bash
node dist/cli/index.js --live --act --budget 0.25 \
  "Improve the stopped Session summary so token and cost limits are distinguishable. Only inspect README.md, src/types.ts, src/workflows/index.ts, and tests/agent/readOnlySessionLoop.test.ts. Make the smallest code and test change, then run npm test."
```

Expected result:

- If it stops, the summary says whether the input-token, cost, or turn limit fired.
- If it exceeds a hard budget on a turn that includes a tool call, Forgelet does not ask for approval for that tool call.
- If it completes, the audit records the changed files and verification command.
