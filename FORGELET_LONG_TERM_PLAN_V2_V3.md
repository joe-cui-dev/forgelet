# Forgelet Long-Term Plan: V2 and V3

This document extends the Forgelet V1 design into a longer-term roadmap. V1 proves the local agent kernel through coding and writing workflow foundations. V2 turns Forgelet into a writing, knowledge, and developer workbench with external read-only context. V3 evolves it into a broader personal agent platform with local creative tools and permissioned personal workflows.

## Product Direction

Forgelet starts as a local-first personal agent kernel with coding as its first fully usable workflow.

The long-term product vision is broader:

> Forgelet becomes a local-first personal agent workbench that can safely act across code, browser context, notes, tasks, documents, and personal workflows while remaining inspectable, permissioned, and educational.

The core principle stays the same across versions:

- Local-first by default
- Explicit permissions for risky actions
- Risk tiered autonomy for everyday flow
- Traceable decisions and tool calls
- Provider-neutral model layer
- Tool-based extensibility
- Useful for real work, not only demos
- Educational traces that help the user understand agent design

## Version Summary

| Version | Theme | Main Outcome |
| --- | --- | --- |
| V1 | Agent kernel with coding first | Forgelet can complete small repo tasks and validate a text-only writing workflow skeleton. |
| V2 | Writing, knowledge, and developer workbench | Forgelet can use browser/file/issue context, resume sessions, curate memory, support richer coding workflows, and create source-linked writing/learning outputs. |
| V3 | Personal platform with local creative tools | Forgelet can support plugins/MCP, local creative tools, personal workflows, calendar/tasks, and multi-surface usage. |

## V2: Writing, Knowledge, and Developer Workbench

### V2 Goal

V2 should make Forgelet useful in daily programming, writing, and learning work, not just small isolated coding tasks.

The main shift from V1 to V2:

- V1: `forge "fix this bug"`
- V1: `forge write --context draft.md "revise this"`
- V2: `forge --with-browser "fix the issue I am viewing"`
- V2: `forge write --with-browser "turn this article into an outline"`
- V2: `forge learn --context paper.md "teach me the core ideas"`
- V2: `forge resume <sessionId>`
- V2: `forge memory review`
- V2: `forge diagnose "backend tests are failing"`

V2 remains workbench-focused. It should support coding, writing, knowledge, and learning workflows, but it should not yet become a general life assistant or local creative-tool platform.

## V2 Major Themes

### 1. Browser Context as a Read-Only Input

**Goal**

Let Forgelet read the page the user is already viewing and use it as task context.

**Use cases**

```bash
forge --with-browser "implement the GitHub issue I am viewing"
forge --with-browser "explain this API doc and update our integration"
forge --with-browser "use this StackOverflow answer to diagnose our bug"
forge browser read-current
```

**Initial capability**

- Read current page URL
- Read title
- Read selected text
- Extract main page text
- Optionally capture screenshot path
- Add browser content as `ContextAttachment`

**Permission boundary**

- Read-only in V2
- No clicking by default
- No form submission
- No password fields
- No cookies/localStorage extraction
- Always show source URL before use
- Trace browser attachment metadata

**Implementation options**

1. Chrome DevTools Protocol connector
2. Browser extension bridge
3. MCP browser server
4. Playwright-controlled browser profile

**Recommended V2 path**

Start with a read-only browser extension bridge that only exposes user-approved current-page tools. Avoid Chrome DevTools Protocol, MCP browser servers, and Playwright-controlled automation for the default V2 path.

**V2 tools**

```text
browser_current_page
browser_extract_text
browser_selected_text
browser_screenshot
```

### 2. Resume and Interactive Session Continuity

**Goal**

Allow Forgelet to continue a previous session after interruption, budget stop, or user review.

**Commands**

```bash
forge resume <sessionId>
forge sessions list
forge sessions show <sessionId>
forge sessions prune
```

**Capabilities**

- Load prior JSONL trace
- Reconstruct task state
- Reconstruct changed files and verification attempts
- Continue with a new user instruction
- Preserve trace lineage

**Design rule**

Resume should not blindly continue destructive actions. It should summarize previous state and ask for confirmation before executing risky follow-up actions.

### 3. Conversation Compaction and Context Budgeting

**Goal**

Keep long-running and resumed Sessions useful without carrying every large tool observation into every later model turn.

**Problem**

V1 dogfood showed that repeated `read_file` observations can make active model context grow quickly. Trace payloads correctly store only metadata and previews, but the live conversation can still carry full returned file chunks from earlier turns. That makes `budget_exceeded` likely even when estimated dollar cost is still low.

V1 uses a deterministic, observation-only compaction guardrail: old model-visible tool observations are compacted against a configurable UTF-8 byte target while recent results and structured execution facts are preserved. Compacted observations become bounded Observation Digests rather than thin summaries, so the model keeps deterministic evidence without replaying the full result. The digest excerpt cap is configurable separately from the total observation target, with a conservative default around 2048 UTF-8 bytes. This bounds the largest demonstrated source of growth, but it is not complete prompt or semantic context management.

V2 should add semantic retention and pinning on top of the deterministic baseline. Semantic retention means keeping observations richer when their meaning is important to the task, such as the file range that contains the suspected bug or the test output that explains a failure. Pinning means explicitly marking selected observations as protected from aggressive compaction, whether the pin comes from a deterministic policy, the model, or a future user-facing review surface.

**Capabilities**

- Build on V1 deterministic observation compaction rather than replacing it.
- Preserve useful deterministic Observation Digests for compacted results before adding semantic summarization.
- Add `activeContext.observationDigestPreviewBytes` as the per-digest excerpt cap, separate from `activeContext.maxObservationBytes`.
- Preserve each compacted result's exact returned range shape, including byte or line bounds and continuation metadata.
- Keep compacted tool messages as JSON observations, with a deterministic model-readable `digest` string inside the payload.
- Add semantic retention for observations whose meaning is central to the task, so they can stay richer than ordinary old observations.
- Add explicit pinning for observations that should remain available in full or near-full across later turns and resumed Sessions.
- Account for other prompt contributors, including historical tool-call arguments, without conflating byte guards with provider token usage.
- Track complete active conversation token pressure separately from persisted Trace evidence.
- Make compaction decisions traceable without storing the full compacted content.
- Work with `forge resume <sessionId>` so resumed Sessions rebuild a compact, reviewable state rather than replaying every large observation verbatim.

**Design rule**

Compaction is a model-context optimization, not a Trace rewrite. The Trace remains the immutable evidence log; the compacted conversation is the Active Context sent to the model.

### 4. Writing and Knowledge Workbench

**Goal**

Promote the V1 writing skeleton into a useful source-linked writing and learning workflow.

**Use cases**

```bash
forge write --creative --style vivid --context draft.md "revise this scene"
forge write --context draft.md "make this sharper and more technical"
forge write --with-browser "turn this article into a draft post outline"
forge learn --context paper.md "teach me the core ideas"
forge notes create --scope project --from-session <sessionId>
forge notes search --scope project "workflow graph design"
```

**Capabilities**

- Critique and revise drafts
- Produce a Revision Pack for short-form creative rewriting via `forge write --creative --style <name>`
- Summarize articles and papers with source links
- Extract concepts and open questions
- Generate study prompts or review questions
- Save user-approved project Markdown notes under `.forgelet/knowledge/`
- Preserve a `--scope project|personal` command shape for future personal knowledge
- Suggest durable memory entries from high-value learning traces
- Search accepted project or personal knowledge

**Boundaries**

- V2 does not become a full document editor.
- V2 does not silently write durable memory.
- V2 does not silently write knowledge notes; note creation requires user approval.
- V2 implements project knowledge first; personal knowledge keeps the same Markdown model for a later release.
- V2 does not publish posts, send messages, or mutate external apps.
- Notes and learning outputs should keep source provenance.
- The Knowledge Library is separate from Durable Memory.

### 5. Project Memory Review and Curation

**Goal**

Turn project memory from a static file into a curated workflow.

**Commands**

```bash
forge memory show
forge memory suggest <sessionId>
forge memory accept
forge memory edit
```

**Memory sources**

- Successful bugfix traces
- Repeated command discoveries
- Test strategy discoveries
- Architecture notes
- User preferences
- Common failure modes

**Memory file**

```text
.forgelet/memory.md
```

**Important rule**

Forgelet should suggest memory updates but not silently write long-term memory without user approval.

### 6. Diagnose Mode

**Goal**

Add a dedicated debugging workflow that follows a disciplined loop:

```text
reproduce -> minimize -> hypothesize -> instrument -> fix -> regression test
```

**Command**

```bash
forge diagnose "backend test is failing"
forge diagnose --context error.log "why does this fail?"
```

**Difference from generic task mode**

Generic task mode may patch quickly. Diagnose mode should first find the exact failure boundary and root cause before applying fixes.

**V2 acceptance standard**

Given a failing test command, Forgelet should:

1. Run or inspect the failing command.
2. Identify the failure boundary.
3. Compare relevant code paths if needed.
4. State root cause before patching.
5. Apply minimal fix.
6. Run targeted regression.

### 7. Better Code Context

**Goal**

Improve code understanding without jumping straight to embeddings.

**Capabilities**

- Symbol search
- Dependency graph hints
- Package/module summary
- Test discovery
- Config discovery
- Framework detection

**Possible tools**

```text
workspace_summary
find_tests
find_package_scripts
find_symbols
read_dependency_graph
```

**Recommended approach**

Use cheap static analysis first:

- `package.json`
- TypeScript config
- import graph
- ripgrep
- test filename conventions

Avoid vector database indexing until there is a clear need.

### 8. Richer Plan and Review Loop

**Goal**

Make Forgelet's execution more transparent and controllable.

**Capabilities**

- Plan approval for large tasks
- Plan revision after failed tools
- Review step before final summary
- Optional model self-review
- Optional second-model review for high-risk patches

**Commands/options**

```bash
forge --plan-first "refactor this module"
forge --reviewer claude "implement this change"
forge --dry-run "show the patch but do not apply it"
```

**Default V2 behavior**

Keep low-risk reads and analysis automatic. Require plan approval or confirmation for broad refactors, durable writes, model escalation, or high-risk file sets.

### 9. Provider and Cost Improvements

**Goal**

Make model use cheaper and more reliable.

**Capabilities**

- Model pricing registry
- Better token estimation
- Fallback on provider failure
- Cheap-model summarization
- Optional model routing by task type

**Example routing**

```text
summarize trace -> cheap model
small coding fix -> DeepSeek V4 Pro
complex architecture review -> Claude or GPT model
high-risk patch review -> second model
```

**Caution**

Automatic routing should be transparent. The final summary should say which model was used and why.

## V2 Candidate Commands

```bash
forge "<task>"
forge diagnose "<problem>"
forge --context file.md "<task>"
forge --with-browser "<task>"
forge write --creative --style vivid --context draft.md "revise this scene"
forge write --context draft.md "revise this for clarity"
forge write --with-browser "turn this article into a post outline"
forge learn --context paper.md "teach me the core ideas"
forge notes create --scope project --from-session <sessionId>
forge notes search --scope project "workflow graph design"
forge ui
forge resume <sessionId>
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
forge memory show
forge memory suggest <sessionId>
forge memory accept
forge config get
forge config set <key> <value>
forge models list
forge models test <modelId>
```

## V2 Non-Goals

V2 should not include:

- General browser automation with clicks and form submission
- Email sending
- Calendar mutation
- Image generation or Photoshop automation
- Full external plugin marketplace
- Vector memory as a default dependency
- Multi-agent orchestration as the default architecture
- Cloud-hosted personal sync
- Mutation-heavy local web UI controls

## V2 Success Standard

Forgelet V2 succeeds when it can handle both of these daily workflows:

1. User opens a GitHub issue or API doc in the browser.
2. User runs `forge --with-browser "implement this"`.
3. Forgelet reads the browser page as a context attachment.
4. Forgelet inspects the local repo.
5. Forgelet creates a plan and executes safe steps.
6. Forgelet applies a focused patch.
7. Forgelet runs targeted tests.
8. Forgelet updates trace and suggests memory updates.
9. User can later run `forge explain <sessionId>` or `forge resume <sessionId>`.
10. User opens a technical article or draft.
11. User runs `forge write --with-browser "turn this into a concise post outline"` or `forge learn --context paper.md "teach me the core ideas"`.
12. Forgelet returns source-linked notes, critique, revision, or learning prompts.
13. Forgelet suggests durable memory updates without writing them automatically.

## V2 Implementation Issues

### V2 Issue 0: Add creative writing Revision Pack

Promote the V1 Writing Workflow into the first useful V2 writing slice before implementing full Session resume or Writing Project continuity.

Acceptance criteria:

- `forge write --creative --style <name> "<creative brief>"` routes to the Writing Workflow.
- `forge write --creative --style <name> --context draft.md "<task>"` remains the revision path for attached source text.
- The first implementation accepts a prompt-level Creative Brief without requiring a `--context` attachment; it still does not accept stdin as the draft source.
- The CLI validates structural inputs such as `--style`, but does not reject prompt-only creative briefs by guessing whether source text is missing.
- The first implementation uses an explicit `--style <name>` option instead of inferring style only from the task text.
- The first built-in style names are `vivid`, `tight`, `literary`, and `plain`; unknown style names produce a clear CLI error.
- Creative writing output is normalized to a Revision Pack with `Critique`, `Revision`, `Alternatives`, and `Notes`.
- `Alternatives` contains two default options: one more vivid/literary and one clearer/tighter.
- The creative writing path remains text-first and does not receive workspace, git, shell, patch, or command tools.
- The first implementation prints the Revision Pack to the terminal and records it in the Trace; it does not write revised prose back to workspace files or `.forgelet` artifacts.
- Session and Trace metadata record `workflow: "writing"` with `workflowVariant: "creative"`; prompt-only creative drafting uses the Session task as the Creative Brief and does not add a separate Trace event.
- This slice does not depend on `forge resume <sessionId>`; long-form Writing Project continuity should be designed after the short-form creative path is useful.
- README documents the short-form creative writing path and names Writing Project continuity as a later goal.

### V2 Issue 1: Add browser context attachment interface

Implement browser-origin `ContextAttachment` support without connecting a real browser yet.

Acceptance criteria:

- `source: "browser"` attachments are accepted.
- Trace records browser source metadata.
- Prompt rendering labels browser content clearly.

### V2 Issue 2: Implement read-only browser provider

Add a read-only browser extension bridge provider for current page URL, title, selected text, main text, and optional screenshot metadata.

Acceptance criteria:

- `forge browser read-current` prints current page metadata.
- `forge --with-browser "<task>"` attaches page content to a task.
- Browser context comes from user-approved extension sharing, not hidden browser inspection.
- No cookies, localStorage, password fields, clicking, typing, or form submission are available.
- No browser mutation tools exist yet.

### V2 Issue 3: Implement session resume

Allow Forgelet to continue from a prior Session through an explicit Session Continuation.

Detailed execution plan: [`docs/session-continuation-execution-plan.md`](docs/session-continuation-execution-plan.md).

Actionable continuation plan: [`docs/actionable-session-continuation-execution-plan.md`](docs/actionable-session-continuation-execution-plan.md).

Acceptance criteria:

- `forge resume <sessionId>` without a new instruction is review-only: it shows previous task, lineage, status, changed files, risks, and last summary, but does not execute model or tool steps.
- `forge resume <sessionId> "<instruction>"` creates a new Session Continuation rather than mutating the prior Session.
- Session Continuations inherit Continuation Context from the entire Session Lineage, not only the immediate parent Session.
- Session Lineage supports branching: one Session may have multiple child continuations for alternate fixes, writing variants, or investigation paths. A resumed Session inherits from its own ancestry path, not from sibling branches.
- Resuming a Session that already has child continuations creates another child from the explicitly named Session. Forgelet does not automatically jump to the latest child or merge sibling branch context.
- Continuation Context includes structured working memory from the lineage: final summaries, plan state, changed files, verification attempts, kernel-observed risks, context attachment metadata, and evidence pointers.
- Continuation Context does not replay every historical model message or full tool result; large observations should flow through compacted evidence such as Observation Digests.
- The resume slice starts with deterministic Continuation Context and does not depend on semantic retention or pinning. It should consume the compact working set provided by the Active Context layer rather than inventing a separate retention policy.
- Session Continuations inherit Context Attachment identity and evidence by default, including source path, source type, preview or summary, hash, and metadata.
- Session Continuations do not automatically reload full Context Attachment content. Users must explicitly request reload through a future `--reuse-context` shape or by passing `--context` again.
- When a continuation reloads attachment content, the Trace records the newly loaded hash and whether it differs from the inherited attachment identity.
- Session Continuations default to the source Session's Workflow. A Workflow switch requires an explicit workflow-shaped resume command, such as a future `forge write resume <sessionId> "<instruction>"`, and the new Trace records the transition.
- Session Continuations inherit the source lineage's Session Read Scope by default, so a narrow multi-turn task keeps its prior workspace boundary.
- A resume command may explicitly add or narrow read scope for the new Session, but lineage inheritance must never silently expand workspace access. The new Trace records inherited and newly requested scope separately.
- The first implementation slice requires a new instruction and defers bare review-only resume. Bare `forge resume <sessionId>` rejects clearly instead of continuing implicitly.
- Continued Sessions write linked trace evidence that records the source Session and lineage relationship.
- Resume never treats unfinished destructive or risky actions from a prior Session as current user approval.
- Session Continuations inherit audit evidence about prior permission, approval, patch, and command events, but every new write, command, external effect, or other risky action must pass through the new Session's Permission Policy.
- Session Continuations take the current workspace state as the new Session baseline, while classifying Forgelet-authored changes from the lineage as inherited changes. They do not reuse the source Session's original workspace baseline as current truth.
- The first resume implementation supports actionable Coding Workflow continuations. `--act` remains the explicit boundary for file writes and configured commands, approvals are requested again, and the final audit distinguishes inherited Forgelet changes from new changes made by the continuation.
- Implement resume in two slices: first read-only live continuation that proves lineage reconstruction, Continuation Context, prompt input, and linked Trace evidence; then actionable continuation with `--act`, fresh approvals, inherited-change classification, and final audit coverage.
- The first read-only live continuation slice supports Coding Workflow resume only. Writing Workflow resume follows after the core lineage and Continuation Context path is proven.
- The first read-only live continuation CLI shape is `forge resume <sessionId> "<instruction>"`.
- The first slice explicitly rejects bare resume, Writing Workflow resume, actionable resume, and context reload shapes such as `forge resume <sessionId>`, `forge write resume <sessionId> "<instruction>"`, `forge resume <sessionId> --act "<instruction>"`, and `forge resume <sessionId> --reuse-context "<instruction>"`.
- Resume rejects unreadable or malformed target Sessions because there is no reliable current lineage anchor.
- Resume may continue with degraded Continuation Context when an ancestor Session is missing, malformed, or incomplete, as long as review output and the new Trace explicitly mark the lineage context as incomplete.
- The first resume implementation supports completed and incomplete or stopped target Sessions, but rejects malformed target Sessions. Continuation Context marks whether the source Session finished cleanly.
- `forge resume <sessionId> "<instruction>"` runs a live model-backed continuation by default. Resume does not create scaffold-only continuation Sessions.
- The first resume implementation must prove inherited Continuation Context in a real model turn. A linked scaffold-only Session is not enough to validate the feature.
- Session Continuations inherit workflow semantics and use the current Routing Policy for the new Session's model route. The prior route is lineage evidence, not a binding model choice.
- Session Continuations use a fresh budget for the new auditable run. They do not inherit or spend from a prior Session's remaining budget, though users may explicitly pass `--budget` or `--model` overrides.
- Live resume output starts with a Continuation header before the model result. The header shows the source Session, new child Session, lineage depth, degraded or incomplete context status, and inherited context highlights.
- Resume tests prove that Continuation Context reaches the model input, not only the Trace. FakeModelClient coverage asserts lineage facts in the prompt or Active Context, and a live dogfood run verifies the model can cite prior Session facts from the inherited context.

### V2 Issue 4: Add conversation compaction

Extend the deterministic V1 observation compactor into semantic context management across multi-turn and resumed Sessions.

Acceptance criteria:

- V1 compact observation facts remain usable as the deterministic baseline.
- Relevant observations can be retained through a traceable semantic policy when their meaning is central to the task.
- Selected observations can be explicitly pinned so compaction does not reduce them below the chosen retention level.
- Historical tool-call arguments, including large patch inputs, are handled without breaking provider assistant/tool message contracts.
- Resumed Sessions reconstruct a compact working set rather than replaying every prior observation and tool argument verbatim.
- Semantic retention and pinning automatically improve Continuation Context once available; resume should use those retained or pinned facts without creating a competing inheritance mechanism.
- Trace remains immutable and metadata-first; compaction does not rewrite saved Trace evidence.
- Budget updates distinguish complete active conversation pressure from persisted Trace size and from the V1 observation byte target.
- Tests cover semantic retention, tool-argument handling, and resumed Session reconstruction.

### V2 Issue 5: Add project memory workflow

Add memory show/suggest/accept commands.

Acceptance criteria:

- Forgelet can suggest memory updates from a trace.
- User approval is required before writing memory.
- Memory entries are concise and editable.

### V2 Issue 6: Add diagnose mode

Add a structured debugging workflow.

Acceptance criteria:

- Diagnose mode reproduces or inspects failure before patching.
- Final summary includes root cause.
- Tests verify the diagnose state machine with mock tools.

### V2 Issue 7: Add test discovery and workspace summary tools

Improve repo awareness with static discovery tools.

Acceptance criteria:

- Forgelet can list package scripts.
- Forgelet can suggest targeted test commands.
- Forgelet can summarize project layout.

### V2 Issue 8: Add model pricing registry and model list/test commands

Make provider setup and cost more visible.

Acceptance criteria:

- `forge models list` shows configured models.
- `forge models test <modelId>` runs a minimal smoke test.
- Final summaries include model IDs and estimated cost.

### V2 Issue 9: Add local review UI

Add a local web UI for inspecting Forgelet state after the core V2 workflows exist.

Acceptance criteria:

- `forge ui` starts a local-only web UI.
- UI can inspect sessions, traces, plans, model/cost summaries, memory suggestions, and knowledge notes.
- UI does not execute workflow actions or mutate external systems by default.
- CLI remains the first-class execution surface.

## V3: Personal Agent Platform

### V3 Goal

V3 evolves Forgelet from a writing, knowledge, and developer workbench into a local-first personal agent platform. It should still be excellent for coding and writing, but it can also help with local creative tools, planning, personal knowledge, and routine life/work workflows.

The main shift from V2 to V3:

- V2: writing, knowledge, and developer workbench with read-only external context
- V3: personal agent platform with local creative tools, extensible tools, multiple surfaces, and curated memory

## V3 Major Themes

### 1. Plugin and MCP Ecosystem

**Goal**

Allow Forgelet to load tools beyond built-in coding/browser capabilities.

**Plugin types**

1. Built-in tool providers
2. Local Forgelet plugins
3. MCP servers
4. Organization/private plugin packs

**Possible tools**

```text
calendar_read
calendar_create_event
tasks_list
tasks_create
notes_search
notes_write
email_draft
web_search
browser_click
browser_type
knowledge_query
```

**Design principle**

All tools, whether built-in or external, must pass through the same layers:

```text
ToolRegistry -> PermissionPolicy -> TraceWriter -> BudgetTracker
```

**Security requirements**

- Tool manifest declares capabilities.
- User approves plugin installation.
- Dangerous tools require explicit permissions.
- Secrets are never exposed directly to model text.
- Tool outputs are summarized and scoped.

### 2. Multi-Surface Product

**Goal**

Let users interact with Forgelet from more than the terminal.

**Possible surfaces**

- CLI
- Local web UI
- Desktop tray/workbench
- Browser extension
- Editor integration

**Recommended order**

1. Late V2 local review UI for sessions, traces, plans, costs, memory suggestions, and knowledge notes
2. Browser extension bridge for current-page context
3. Editor integration only if CLI workflows prove limiting
4. Desktop app if notifications/background tasks become important

**Important rule**

The CLI should remain first-class. UI surfaces should talk to the same core engine. The first local web UI should be inspect/review oriented; mutation-heavy controls come later.

### 3. Personal Knowledge and Learning Assistant

**Goal**

Support learning workflows without turning Forgelet into a generic notes app.

**Use cases**

```bash
forge learn --context paper.md "teach me the core ideas"
forge learn --with-browser "turn this article into study notes"
forge quiz "review my notes on agent tool calling"
forge notes search "permission policy design"
```

**Capabilities**

- Summarize articles/docs
- Extract concepts
- Generate study questions
- Maintain learning notes
- Link notes to source URLs/files
- Create spaced repetition cards later

**Memory boundary**

Learning memory should be curated and source-linked. Forgelet should avoid silently accumulating low-quality summaries.

### 4. Personal Workflow Automation

**Goal**

Help with routine tasks across work and life while keeping actions permissioned.

**Possible workflows**

- Draft email replies
- Summarize meeting notes
- Turn notes into tasks
- Prepare daily plan
- Create reminders
- Plan errands or travel
- Track recurring personal projects

**Mutation boundary**

V3 may draft actions automatically, but mutation should require confirmation:

- Sending email
- Creating calendar events
- Purchasing items
- Deleting files
- Posting messages
- Submitting forms

### 5. Local Creative Tool Workflows

**Goal**

Support local creative tools after the tool provider, capability, permission, trace, and asset boundaries are mature.

**Use cases**

```bash
forge image edit --context brief.md input.png "create three retouch options"
forge image generate --context moodboard.md "make a cover image draft"
forge photoshop draft-actions input.psd "clean up the background non-destructively"
```

**Capabilities**

- Read and write local asset files
- Run local Stable Diffusion or similar image tools
- Draft Photoshop actions or scripts for user review
- Compare before/after assets
- Export traceable variants

**Boundaries**

- V3 should not require cloud image generation.
- External app mutation requires explicit capability grants and user confirmation.
- Original assets should be preserved unless the user approves replacement.
- Creative workflows should report model/tool cost, runtime, source assets, and output paths.

### 6. Stronger Memory Architecture

**Goal**

Support both project-specific and personal memory safely.

**Memory layers**

```text
Project memory: .forgelet/memory.md
Global user memory: ~/.forgelet/memory.md
Project knowledge: .forgelet/knowledge/*.md
Personal knowledge: ~/.forgelet/knowledge/*.md
Session traces: .forgelet/sessions/*.jsonl
Optional vector index: derived cache, rebuildable
```

**Memory principles**

- User can inspect all durable memory.
- User can edit/delete memory.
- Memory writes require approval or configured rules.
- Memory includes provenance.
- Knowledge notes are Markdown source files, not memory entries.
- Project and personal knowledge use the same note model with different scopes.
- Embeddings/vector stores are caches, not source of truth.

### 7. Workflow Graphs and Skills

**Goal**

Move beyond a single generic loop for workflows that benefit from structure.

**Examples**

```text
coding bugfix workflow
diagnose workflow
PR review workflow
learning workflow
local creative workflow
browser research workflow
daily planning workflow
```

**Architecture**

V3 can introduce workflow graphs while keeping the ReAct loop inside selected nodes.

Example:

```text
intake -> gather_context -> plan -> act_loop -> review -> summarize -> memory_review
```

**Design rule**

Use structured workflows when the task has a known reliable shape. Use ReAct loops where exploration is needed.

### 8. Controlled Browser Automation

**Goal**

Move from read-only browser context to permissioned browser actions.

**Capabilities**

- Click
- Type
- Navigate
- Extract table/data
- Download file
- Fill drafts

**Hard boundaries**

- No automatic purchase
- No automatic form submission without confirmation
- No password entry
- No hidden cookie/localStorage scraping
- Show URL and action summary before mutations
- Trace every browser action

### 9. Collaboration and Review Modes

**Goal**

Use multiple models or roles only when they add clear value.

**Possible modes**

- Coder + reviewer
- Diagnoser + fixer
- Planner + executor
- Cheap model summarizer + strong model patcher
- Human approval checkpoint

**Caution**

Multi-agent architecture should not be the default. It increases cost and coordination complexity. V3 should use it selectively for high-risk tasks.

## V3 Candidate Commands

```bash
forge plugins list
forge plugins install <plugin>
forge mcp add <server>
forge browser act "<task>"
forge learn --context article.md "teach this to me"
forge notes search "agent memory"
forge image edit input.png "make this cleaner"
forge photoshop draft-actions input.psd "remove the background"
forge tasks create "follow up on PR review"
forge daily plan
forge workflow run diagnose "tests are failing"
forge review --model claude <sessionId>
```

## V3 Non-Goals

V3 should still avoid:

- Fully autonomous life actions without approval
- Hidden background surveillance
- Opaque memory writes
- Cloud sync as a requirement
- Plugin execution without declared permissions
- Making vector search the only memory layer

## V3 Success Standard

Forgelet V3 succeeds when it can support this cross-domain workflow:

1. User opens a technical article in the browser.
2. Forgelet extracts the article as context.
3. Forgelet creates learning notes with source links.
4. User asks Forgelet to apply the idea to a local codebase.
5. Forgelet modifies code safely and runs tests.
6. User asks Forgelet to draft a source-linked visual or article asset.
7. Forgelet runs or drafts local creative-tool actions with explicit permission.
8. Forgelet drafts a follow-up task/reminder.
9. Forgelet suggests durable memory updates.
10. User can review the complete trace in CLI or local UI.
11. No external action is taken without permission.

## V3 Implementation Epics

### Epic 1: Plugin Runtime

- Tool manifest format
- Local plugin loading
- Capability declarations
- Permission integration
- Trace integration
- Plugin test harness

### Epic 2: MCP Integration

- MCP server config
- Tool discovery
- Tool schema conversion
- Permission classification
- Trace events for MCP calls

### Epic 3: Local Web UI

- Session browser
- Trace viewer
- Plan viewer
- Memory editor
- Config editor
- Model/cost dashboard

### Epic 4: Browser Extension Bridge

- Current page context
- Selected text capture
- Source metadata
- Optional read-only screenshot
- Later: controlled actions

### Epic 5: Personal Knowledge Layer

- Source-linked notes
- Learning summaries
- Search
- Markdown source of truth under `.forgelet/knowledge/` and later `~/.forgelet/knowledge/`
- User-approved memory writes
- Optional vector index cache

### Epic 6: Workflow Engine

- Workflow graph definition
- Built-in workflows
- Human approval checkpoints
- Workflow trace visualization

### Epic 7: Personal Tools

- Calendar read/create draft
- Task manager integration
- Notes integration
- Email draft integration
- Reminder integration

### Epic 8: Local Creative Tools

- Asset attachment and output model
- Stable Diffusion provider
- Photoshop action/script draft provider
- Before/after comparison summaries
- Creative workflow trace events

## Roadmap Ordering Recommendation

### After V1, build V2 in this order

1. Browser context attachment foundation
2. Read-only browser extension bridge provider
3. Writing workflow hardening
4. Source-linked learning and notes workflow
5. Session resume
6. Conversation compaction and active context budgeting
7. Project memory review workflow
8. Diagnose mode
9. Workspace summary and test discovery tools
10. Model pricing registry and model diagnostics
11. Local review UI for traces, memory, and knowledge

### After V2, build V3 in this order

1. MCP integration for external tools
2. Plugin runtime
3. Browser extension bridge hardening
4. Workflow graph engine
5. Local creative tool workflows
6. Permissioned personal tools
7. Controlled browser automation

## Design Risks

### Risk: Scope creep into a generic assistant

Mitigation:

- Keep V2 workbench-focused: coding, writing, learning, read-only browser context, and curated memory.
- Add life and creative mutation tools only after tool registry, permission, trace, asset, and memory boundaries are solid.

### Risk: Browser automation creates unsafe behavior

Mitigation:

- V2 browser support is read-only.
- V2 browser context comes from user-approved extension sharing.
- V3 browser mutation requires explicit approval and trace.

### Risk: Memory becomes noisy or wrong

Mitigation:

- Require curation.
- Store provenance.
- Let users edit/delete memory.
- Treat vector indexes as rebuildable caches.

### Risk: Multi-provider support becomes leaky

Mitigation:

- Keep `ModelClient` stable.
- Use provider adapters.
- Add fixture tests for request/response mapping.

### Risk: Plugin ecosystem weakens safety

Mitigation:

- Tool manifests declare capabilities.
- Permission policy remains central.
- Trace all external tool calls.
- Avoid passing secrets to model context.

## Durable Architectural Commitments

These decisions should survive across V1, V2, and V3:

1. Forgelet remains local-first.
2. The CLI remains a first-class surface.
3. Model providers stay behind adapters.
4. Tools go through a registry.
5. Risky actions go through permission policy.
6. Risk tiers guide autonomy before tool execution.
7. Every run produces an inspectable trace.
8. Memory writes are curated and auditable.
9. External context is represented as structured attachments.
10. Cost and token use stay visible.
11. Learning/explainability remains part of the product, not an afterthought.
