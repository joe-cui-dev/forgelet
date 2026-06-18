# Forgelet V1 Implementation Issues

This document breaks the Forgelet V1 technical design into the first implementation issues. The order is intentional: start with the CLI skeleton, then configuration, trace, tool registry, mock agent loop, and finally real model providers.

## Milestone 0: Repository Bootstrap

### Issue 1: Scaffold the TypeScript CLI project

**Goal**

Create the initial Forgelet repository structure and make `forge` runnable locally after build/link.

**User value**

A developer can clone the repo, install dependencies, build the project, and run the Forgelet CLI entrypoint.

**Scope**

- Create `package.json` with `bin.forge = ./dist/cli/index.js`.
- Add TypeScript config.
- Add source layout:
  - `src/cli/`
  - `src/agent/`
  - `src/config/`
  - `src/trace/`
  - `src/tools/`
  - `src/permissions/`
  - `src/models/`
  - `src/workspace/`
  - `src/context/`
  - `src/budget/`
- Add `tests/` folder.
- Add scripts:
  - `npm run build`
  - `npm test`
  - `npm run typecheck`
- Implement a minimal CLI that prints version/help and accepts a task string.

**Out of scope**

- Real model calls.
- Real tool execution.
- Config persistence.

**Acceptance criteria**

- `npm install` succeeds.
- `npm run build` succeeds.
- `node dist/cli/index.js --help` prints help.
- After `npm link`, `forge --help` works.
- `forge "hello"` parses the task and exits with a placeholder response.

---

### Issue 2: Add core domain types

**Goal**

Define the shared TypeScript types used by the agent loop, model layer, tools, permissions, trace, context attachments, and budgets.

**User value**

The codebase has clear contracts before implementation complexity grows.

**Scope**

Add types for:

- `AgentSession`
- `AgentStage`
- `AgentPlan`
- `PlanItem`
- `ModelClient`
- `ModelProvider`
- `ModelTurnInput`
- `ModelTurnOutput`
- `ModelToolCall`
- `ToolDefinition`
- `ToolRegistry`
- `ToolContext`
- `ToolResult`
- `PermissionPolicy`
- `PermissionDecision`
- `TraceEvent`
- `ContextAttachment`
- `BudgetLimits`
- `BudgetUsage`

**Out of scope**

- Implementing behavior behind these types.

**Acceptance criteria**

- Types compile under `strict` TypeScript settings.
- Types are documented enough to guide implementation.
- No module imports from concrete provider/tool implementations are needed in agent loop types.

---

## Milestone 1: CLI Skeleton and Command Surface

### Issue 3: Implement V1 CLI command parser

**Goal**

Support the initial Forgelet command surface without requiring real agent execution yet.

**User value**

Users can see and invoke the intended V1 commands.

**Scope**

Implement parsing for:

```bash
forge "<task>"
forge --context issue.md "<task>"
forge write --context draft.md "revise this"
forge --model deepseek-v4-pro "<task>"
forge --budget 0.25 "<task>"
forge config get
forge config set memoryFile .forgelet/memory.md
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
forge memory suggest <sessionId>
forge memory accept <suggestionId>
```

**Out of scope**

- Full agent execution.
- Real session explanation.
- Real config storage beyond stubs if Issue 4 is not done yet.

**Acceptance criteria**

- CLI validates required arguments.
- CLI exits non-zero for invalid commands.
- CLI returns clear errors for missing task/session/config keys.
- `forge write` routes to a writing workflow command shape, even if execution is still stubbed.
- `forge memory suggest` and `forge memory accept` parse as memory commands, even if execution is still stubbed.
- CLI parser has unit tests for all V1 commands.

---

### Issue 4: Implement user-facing terminal output primitives

**Goal**

Create a small output layer for plans, status updates, warnings, errors, and final summaries.

**User value**

Forgelet has consistent CLI behavior from the start.

**Scope**

- Add functions for:
  - printing a plan
  - updating plan item statuses
  - printing tool status lines
  - printing permission prompts or decisions
  - printing final summaries
  - printing budget summaries
- Keep output plain and script-friendly.
- Avoid exposing raw JSON unless requested.

**Out of scope**

- Interactive rich TUI.
- Streaming model text UI.

**Acceptance criteria**

- Output functions are covered by snapshot or string tests.
- Final summary supports changed files, tests run, cost estimate, trace path, and remaining risks.

---

## Milestone 2: Configuration

### Issue 5: Implement global and project config loading

**Goal**

Load and merge global config from `~/.forgelet/config.json` and project config from `<repo>/.forgelet/config.json`.

**User value**

Users can set provider env vars, safe commands, budgets, and project memory location. Model defaults stay in `src/config/index.ts`.

**Scope**

- Define config schema.
- Load global config.
- Load project config.
- Merge with defaults.
- Validate config with clear errors.
- Expand `~` in paths where relevant.

**Default global config shape**

```json
{
  "providers": {
    "deepseek": { "apiKeyEnv": "DEEPSEEK_API_KEY" },
    "openai": { "apiKeyEnv": "OPENAI_API_KEY" },
    "anthropic": { "apiKeyEnv": "ANTHROPIC_API_KEY" }
  },
  "budgets": {
    "maxModelTurns": 12,
    "maxInputTokens": 120000,
    "maxEstimatedCostUsd": 1.0
  }
}
```

**Default project config shape**

```json
{
  "safeCommands": ["npm test", "npm run build", "npx jest"],
  "testCommands": ["npm test", "npm run build"],
  "memoryFile": ".forgelet/memory.md"
}
```

**Acceptance criteria**

- Missing config files are handled with defaults.
- Invalid JSON produces a helpful error.
- Global and project settings merge deterministically.
- Unit tests cover defaults, overrides, invalid JSON, and invalid schema.

---

### Issue 6: Implement `forge config get` and `forge config set`

**Goal**

Allow users to inspect and update global Forgelet configuration.

**User value**

Users can set provider preferences without manually editing JSON. Model defaults are edited in `src/config/index.ts`.

**Scope**

- `forge config get` prints merged config or global config clearly.
- `forge config set <key> <value>` updates global config.
- Reject model default keys such as `defaultModel`, `fallbackModel`, `cheapModel`, and `routing.*`.
- Support at least non-model keys such as:
  - `memoryFile`
  - provider API key env var names
- Preserve existing unknown keys if possible.
- Create `~/.forgelet/config.json` if missing.

**Out of scope**

- Editing project config.
- Secret storage.

**Acceptance criteria**

- `forge config set defaultModel deepseek-v4-pro` fails with a clear message.
- `forge config get` displays model defaults from `src/config/index.ts`.
- Tests use a temporary home directory.

---

## Milestone 3: Trace and Sessions

### Issue 7: Implement JSONL TraceWriter

**Goal**

Persist every agent run as a structured JSONL trace in `.forgelet/sessions/<sessionId>.jsonl`.

**User value**

Users can audit what Forgelet did, debug behavior, and later generate explanations.

**Scope**

- Generate session IDs.
- Ensure `.forgelet/sessions/` exists in the target workspace.
- Append trace events as JSONL.
- Support event types:
  - `user_task`
  - `context_attachment`
  - `model_turn`
  - `tool_call`
  - `tool_result`
  - `permission_decision`
  - `plan_update`
  - `budget_update`
  - `final_summary`
- Add timestamps.
- Avoid writing full secret values.

**Acceptance criteria**

- Trace files are valid JSONL.
- Trace writer can append multiple events.
- Tests verify event ordering and required fields.

---

### Issue 8: Implement session listing and display commands

**Goal**

Support `forge sessions list` and `forge sessions show <sessionId>`.

**User value**

Users can find and inspect past Forgelet runs.

**Scope**

- List trace files under `.forgelet/sessions/`.
- Show session ID, timestamp, task summary, final status if available.
- Display a readable summary for a selected session.
- Handle malformed trace lines gracefully.

**Out of scope**

- Resume support.
- Full explain mode.

**Acceptance criteria**

- Empty sessions directory prints a helpful message.
- List command shows created sessions.
- Show command reads a selected JSONL trace.
- Tests cover empty, valid, and partially malformed traces.

---

## Milestone 4: Context Attachments

### Issue 9: Implement `--context <file>` text attachments

**Goal**

Allow users to attach a text file as structured task context.

**User value**

Users can pass issues, specs, logs, and notes into Forgelet without manually pasting large text.

**Scope**

- Support `.md`, `.txt`, `.log`, `.json`.
- Load workspace-relative paths.
- Load explicit user paths.
- Create `ContextAttachment` objects.
- Write `context_attachment` trace events.
- Add source labels when passing attachments to the model.

**Out of scope**

- PDF, images, DOCX.
- Browser or clipboard context.

**Acceptance criteria**

- `forge --context issue.md "implement this"` loads the file.
- Missing file returns a clear error.
- Unsupported extension returns a clear error.
- Attachment metadata is written to trace.
- Tests cover supported, missing, and unsupported files.

---

## Milestone 5: Permissions and Budgeting

### Issue 10: Implement command and file permission policy

**Goal**

Classify tool requests through workflow capability grants, risk tiers, and then allow, confirm, or deny before execution.

**User value**

Forgelet can act autonomously for safe operations while guarding risky actions.

**Scope**

Default workflow grants:

- Coding workflow: `read_workspace`, `write_workspace`, `run_safe_command`, `git_read`, `update_plan`, `model_generate_text`.
- Writing workflow: `read_context`, `update_plan`, `model_generate_text`.

Default risk tiers:

- Low risk: file reads in workspace, browser read-only context, `git status`, `git diff`, planning, critique, and non-durable model output.
- Medium risk: writes inside workspace, commands listed in `safeCommands`, accepted knowledge notes, and accepted memory suggestions.
- High risk: dependency installs, network requests, commit, push, deploy, cross-workspace writes, model escalation with meaningful cost, and external app mutation.
- Forbidden risk: destructive commands, credential exfiltration, hidden browser scraping, and unapproved secret-file edits.

Sensitive files include:

- `.env`
- `.env.*`
- files containing `secret`, `token`, `key`, or `credential` in obvious secret contexts

Dangerous commands include:

- `rm -rf`
- `git reset --hard`
- `git checkout -- <path>`
- deploy commands unless explicitly approved

**Acceptance criteria**

- Tool calls without a workflow grant are denied before command-level risk checks.
- Tool calls include a risk tier before execution.
- Coding workflow receives workspace read/write and safe command grants.
- Writing workflow does not receive workspace write or shell command grants by default.
- Permission decisions are deterministic.
- Decisions include a reason.
- Permission decisions include risk tier.
- Permission decisions are written to trace.
- Unit tests cover grant denial, low/medium/high/forbidden tiers, safe, confirm, and deny cases.

---

### Issue 11: Implement budget tracker

**Goal**

Track model turns, token estimates, and estimated cost during a run.

**User value**

Users can control token spend, especially when using multiple model providers.

**Scope**

- Load budget defaults from config.
- Support CLI `--budget <usd>` override.
- Track model turn count.
- Track estimated input/output tokens when provider usage exists.
- Estimate cost using provider/model pricing table when available.
- Stop gracefully when budget is exceeded or nearly exceeded.
- Write `budget_update` trace events.

**Out of scope**

- Perfect tokenizer accuracy.
- Automatic semantic model routing beyond the configured workflow-stage routing policy.

**Acceptance criteria**

- Budget tracker stops agent after max model turns.
- Budget tracker stops agent after max estimated cost.
- Final summary includes model turns, token estimate, and cost estimate.
- Tests cover turn-limit and cost-limit interruption.

---

## Milestone 6: Tool Registry and Built-in Tools

### Issue 12: Implement internal Tool Registry

**Goal**

Create the registry that exposes tool definitions to the model and dispatches tool calls to implementations.

**User value**

Forgelet can add tools cleanly without coupling the agent loop to specific tool implementations.

**Scope**

- Register built-in tools.
- Store provider ID and capability metadata for each tool.
- Expose tool schemas for model requests.
- Dispatch by tool name.
- Validate tool input against schema.
- Return normalized `ToolResult`.
- Write tool call/result events to trace.

**Acceptance criteria**

- Duplicate tool names are rejected.
- Tools without provider ID or capability metadata are rejected.
- Unknown tool calls return a controlled error.
- Invalid input returns a controlled error.
- Tests cover registration, provider/capability metadata, dispatch, unknown tools, and invalid input.

---

### Issue 13: Implement read-only workspace tools

**Goal**

Implement the safe read-only tools needed for repo exploration.

**User value**

Forgelet can inspect a codebase before deciding what to change.

**Tools**

- `list_files`
- `search_text`
- `read_file`
- `git_status`
- `git_diff`

**Scope**

- Prefer `rg` for file listing/search where available.
- Restrict file reads to allowed paths.
- Limit output size and summarize large results.
- Normalize errors.

**Acceptance criteria**

- Each tool has schema and tests.
- Search works on a temp test repo.
- Read file rejects paths outside allowed workspace unless explicitly permitted.
- Git tools return useful summaries.

---

### Issue 14: Implement `apply_patch` workspace edit tool

**Goal**

Allow Forgelet to apply model-proposed patches inside the current workspace.

**User value**

Forgelet can complete coding tasks, not just suggest changes.

**Scope**

- Accept unified patch or structured patch input.
- Apply only within workspace.
- Use permission policy before write.
- Reject sensitive file edits by default.
- Return changed files summary.
- Ensure failures are readable and recoverable.

**Out of scope**

- Auto-commit.
- Formatting every file automatically.

**Acceptance criteria**

- Applies a valid patch in a temp repo.
- Rejects path traversal/outside-workspace patches.
- Rejects sensitive file changes by default.
- Trace records patch attempt and result.

---

### Issue 15: Implement `run_command` tool

**Goal**

Allow Forgelet to run approved commands such as tests and builds.

**User value**

Forgelet can verify its own changes.

**Scope**

- Execute commands in workspace.
- Require permission decision before execution.
- Allow commands from `safeCommands`.
- Capture stdout, stderr, exit code, duration.
- Enforce timeout.
- Summarize large output.

**Out of scope**

- Arbitrary shell sessions.
- Interactive commands.

**Acceptance criteria**

- Safe command executes in temp workspace.
- Unsafe command asks for confirmation or returns controlled denial in non-interactive tests.
- Timeout is enforced.
- Output is summarized and traced.

---

### Issue 16: Implement `update_plan` tool

**Goal**

Allow the agent to create and update a visible plan during execution.

**User value**

Users can follow what Forgelet is doing and learn the agent process.

**Scope**

- Tool accepts plan items with statuses.
- Enforce at most one `in_progress` item.
- Print plan updates to terminal.
- Write `plan_update` trace events.

**Acceptance criteria**

- Valid plan update is accepted.
- Invalid multiple `in_progress` items are rejected.
- Plan output is stable and readable.
- Tests cover valid and invalid updates.

---

## Milestone 7: Mock Agent Loop

### Issue 17: Implement ReAct agent loop with mock model support

**Goal**

Build the core agent loop using a mock model before connecting real providers.

**User value**

Forgelet's orchestration can be tested deterministically and cheaply.

**Scope**

- Load task, config, context attachments, budget, and trace.
- Create initial model input.
- Send tool schemas to model client.
- Dispatch model tool calls through Tool Registry.
- Feed tool results back into model history.
- Stop on final response or budget/turn limit.
- Move through stages: intake, plan, work, review, final.

**Out of scope**

- Real LLM API calls.
- Advanced context compaction.

**Acceptance criteria**

- Mock model can request `search_text`, then `read_file`, then `apply_patch`, then `run_command`, then final.
- Loop dispatches tool calls in order.
- Trace contains user task, model turns, tool calls/results, budget updates, final summary.
- Loop stops on budget limit.
- Tests cover successful final, tool error recovery, and budget stop.

---

### Issue 18: Implement final summary generation from run state

**Goal**

Produce a consistent end-of-run summary regardless of success, partial completion, or failure.

**User value**

Users always know what happened, what changed, what was verified, and what remains risky.

**Scope**

Final summary includes:

- Status: success, partial, failed, blocked
- Changed files
- Verification commands and results
- Model turns
- Estimated tokens/cost
- Trace path
- Remaining risks
- Suggested next action if partial or failed

**Acceptance criteria**

- Summary works for success.
- Summary works for tool failure.
- Summary works for budget stop.
- Summary is written to trace as `final_summary`.

---

## Milestone 8: Explain Mode

### Issue 19: Implement `forge explain <sessionId>`

**Goal**

Generate a learning-oriented explanation from a saved trace.

**User value**

Forgelet helps the user understand agent principles, not just get work done.

**Scope**

Explain:

- Stages traversed
- Plan changes
- Tools used and why they mattered
- Permission decisions
- Failures and retries
- Verification steps
- Budget/cost summary
- What this run illustrates about agent design

**Out of scope**

- Calling a model to explain the trace. V1 can generate a deterministic explanation.

**Acceptance criteria**

- Explain works on a valid trace.
- Explain handles incomplete traces.
- Output is readable in terminal.
- Tests cover a representative trace.

---

### Issue 27: Implement user-approved memory suggestions

**Goal**

Generate durable-memory suggestions from traces and write them only after user approval.

**User value**

Forgelet can learn useful project habits without silently polluting future sessions with noisy or wrong memory.

**Scope**

- Add `MemorySuggestion` type.
- Add `forge memory suggest <sessionId>`.
- Add `forge memory accept <suggestionId>`.
- Store proposed suggestions separately from accepted durable memory.
- Append accepted entries to configured `memoryFile`.
- Include source session provenance in accepted entries.
- Write `memory_suggestion` and `memory_acceptance` trace events.

**Out of scope**

- Automatic memory writes.
- Vector database memory.
- Global personal memory outside the project memory file.

**Acceptance criteria**

- Suggestions can be generated from a representative trace.
- Suggestions are not written to durable memory until accepted.
- Accepted entries include source session provenance.
- Rejected or unaccepted suggestions are not loaded as durable memory.
- Tests cover suggest, accept, and no-silent-write behavior.

---

## Milestone 9: Real Model Providers

### Issue 20: Implement model provider registry and selection

**Goal**

Select a provider/model from code-defined workflow-stage routing, fallback rules, or CLI override.

**User value**

Users can choose a different model for a single run with `--model`, while Forgelet keeps default model routing in code and remains cost-aware by default.

**Scope**

- Parse model IDs and provider mapping.
- Use code-defined routing by workflow and stage.
- Let `--model` override routing for the run.
- Support code-defined fallback and explicit review model routing.
- Record the selected route and reason in the run state or trace.
- Return clear errors for missing API key env vars.

**Acceptance criteria**

- `deepseek-v4-pro` resolves to DeepSeek provider.
- Coding default route resolves to `deepseek-v4-flash`.
- Writing default route resolves to `deepseek-v4-flash`.
- CLI override beats code-defined routing.
- Missing API key produces actionable error.
- Tests cover provider selection, workflow-stage routing, CLI override, and fallback routing.

---

### Issue 21: Implement DeepSeek provider adapter

**Goal**

Connect Forgelet to DeepSeek through the `ModelClient` interface.

**User value**

Users can run Forgelet with a low-cost primary model.

**Scope**

- Support `deepseek-v4-pro`.
- Support `deepseek-v4-flash`.
- Use DeepSeek API key from configured env var.
- Convert Forgelet tools to DeepSeek-compatible tool schema.
- Convert DeepSeek tool calls back to `ModelToolCall`.
- Capture usage when returned.
- Normalize provider errors.

**Out of scope**

- Provider-specific optimization beyond basic tool calling.

**Acceptance criteria**

- Manual smoke test can call DeepSeek with a simple prompt.
- Manual smoke test can execute one tool call through mock/safe tool.
- Unit tests cover request/response mapping with fixtures.

---

### Issue 22: Implement OpenAI provider adapter

**Goal**

Connect Forgelet to OpenAI-compatible models through the `ModelClient` interface.

**User value**

Users can use ChatGPT/OpenAI models for coding tasks or fallback.

**Scope**

- Use API key from configured env var.
- Support configurable model IDs.
- Convert tool schemas and tool calls.
- Capture usage when returned.
- Normalize provider errors.

**Acceptance criteria**

- Manual smoke test can call configured OpenAI model.
- Unit tests cover request/response mapping with fixtures.

---

### Issue 23: Implement Anthropic provider adapter

**Goal**

Connect Forgelet to Claude through the `ModelClient` interface.

**User value**

Users can use Claude models for complex coding or fallback.

**Scope**

- Use API key from configured env var.
- Support configurable model IDs.
- Convert Forgelet tool definitions to Anthropic tool format.
- Convert Anthropic tool calls back to `ModelToolCall`.
- Capture usage when returned.
- Normalize provider errors.

**Acceptance criteria**

- Manual smoke test can call configured Claude model.
- Unit tests cover request/response mapping with fixtures.

---

## Milestone 10: Documentation and First End-to-End Validation

### Issue 24: Add README, architecture doc, and ADRs

**Goal**

Document how to use Forgelet and why its architecture is shaped this way.

**User value**

The project doubles as a usable tool and a learning resource for agent system design.

**Scope**

Add:

- `README.md`
- `ARCHITECTURE.md`
- `docs/adr/0001-local-cli-first.md`
- `docs/adr/0002-tool-providers-and-capabilities.md`
- `docs/adr/0003-workflow-graphs-with-react-nodes.md`
- `docs/adr/0004-v1-includes-writing-workflow-skeleton.md`
- `docs/adr/0005-workflow-stage-model-routing.md`
- `docs/adr/0006-workflow-capability-grants.md`
- `docs/adr/0007-user-approved-memory-persistence.md`
- `docs/adr/0008-markdown-knowledge-library.md`
- `docs/adr/0009-local-review-ui-after-core-workflows.md`
- `docs/adr/0010-browser-context-extension-bridge-first.md`
- `docs/adr/0011-risk-tiered-autonomy.md`
- Provider adapter ADR
- Permission policy ADR

**Acceptance criteria**

- README explains install, link, configure, and run.
- Architecture doc matches implementation.
- ADRs explain decisions and tradeoffs.

---

### Issue 25: Run first real-repo success test

**Goal**

Validate Forgelet against the first success standard: completing a small bugfix in a real TypeScript repo.

**User value**

Proves Forgelet is not only a toy demo.

**Scope**

- Pick a small known failing test in a real TypeScript repo.
- Run `forge "fix the failing test"`.
- Let Forgelet search/read/patch/run targeted test.
- Inspect diff.
- Capture trace.
- Document what worked and what failed.

**Acceptance criteria**

- Forgelet applies a minimal patch.
- Targeted test passes.
- Final summary includes changed files, verification command, cost estimate, and trace path.
- No high-risk action is performed without permission.
- Any failure is turned into a follow-up issue.

---

### Issue 26: Validate writing workflow skeleton

**Goal**

Validate that Forgelet can run a text-only non-code workflow through the same kernel boundaries.

**User value**

Proves Forgelet is becoming a personal agent platform rather than a coding-only CLI.

**Scope**

- Create a small draft text fixture.
- Run `forge write --context draft.md "revise this for clarity"`.
- Ensure the writing workflow does not receive workspace edit or shell tools by default.
- Capture trace, model ID, and estimated cost.
- Document what worked and what failed.

**Acceptance criteria**

- Forgelet loads text context as a structured attachment.
- Writing workflow returns revised text or critique.
- Final summary includes model ID, estimated cost, and trace path.
- No code workspace mutation tools are available to the writing workflow by default.
- Any failure is turned into a follow-up issue.

---

## Suggested Build Order

1. Issue 1: Scaffold the TypeScript CLI project
2. Issue 2: Add core domain types
3. Issue 3: Implement V1 CLI command parser
4. Issue 5: Implement global and project config loading
5. Issue 7: Implement JSONL TraceWriter
6. Issue 12: Implement internal Tool Registry
7. Issue 10: Implement command and file permission policy
8. Issue 13: Implement read-only workspace tools
9. Issue 16: Implement `update_plan` tool
10. Issue 17: Implement ReAct agent loop with mock model support
11. Issue 18: Implement final summary generation from run state
12. Issue 14: Implement `apply_patch` workspace edit tool
13. Issue 15: Implement `run_command` tool
14. Issue 11: Implement budget tracker
15. Issue 9: Implement `--context <file>` text attachments
16. Issue 8: Implement session listing and display commands
17. Issue 19: Implement `forge explain <sessionId>`
18. Issue 27: Implement user-approved memory suggestions
19. Issue 20: Implement model provider registry and selection
20. Issue 21: Implement DeepSeek provider adapter
21. Issue 22: Implement OpenAI provider adapter
22. Issue 23: Implement Anthropic provider adapter
23. Issue 24: Add README, architecture doc, and ADRs
24. Issue 26: Validate writing workflow skeleton
25. Issue 25: Run first real-repo success test

## MVP-B Cut Line

MVP-B is complete after these issues are done:

- Issue 1
- Issue 2
- Issue 3
- Issue 5
- Issue 7
- Issue 10
- Issue 12
- Issue 13
- Issue 14
- Issue 15
- Issue 16
- Issue 17
- Issue 18

At that point Forgelet should be able to run a mocked coding-agent loop and perform real local workspace operations under permission control.

## MVP-C Cut Line

MVP-C adds:

- Issue 8
- Issue 9
- Issue 11
- Issue 19
- Issue 27
- Issue 20
- Issue 21
- Issue 22
- Issue 23
- Issue 24
- Issue 25

At that point Forgelet should support learning traces, context attachments, budgets, and real model providers.
