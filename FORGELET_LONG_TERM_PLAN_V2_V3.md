# Forgelet Long-Term Plan: V2 and V3

This document extends the Forgelet V1 design into a longer-term roadmap. V1 proves the local coding-agent loop. V2 turns Forgelet into a stronger daily developer assistant with external context. V3 evolves it into a personal agent platform for work, learning, and life.

## Product Direction

Forgelet starts as a local-first CLI coding agent.

The long-term product vision is broader:

> Forgelet becomes a local-first personal agent workbench that can safely act across code, browser context, notes, tasks, documents, and personal workflows while remaining inspectable, permissioned, and educational.

The core principle stays the same across versions:

- Local-first by default
- Explicit permissions for risky actions
- Traceable decisions and tool calls
- Provider-neutral model layer
- Tool-based extensibility
- Useful for real work, not only demos
- Educational traces that help the user understand agent design

## Version Summary

| Version | Theme | Main Outcome |
| --- | --- | --- |
| V1 | Local coding agent | Forgelet can complete small repo tasks with search/read/patch/test/diff. |
| V2 | Developer workbench | Forgelet can use browser/file/issue context, resume sessions, manage project memory, and support richer coding workflows. |
| V3 | Personal agent platform | Forgelet can support plugins/MCP, personal knowledge, learning workflows, calendar/tasks, and multi-surface usage. |

## V2: Developer Workbench

### V2 Goal

V2 should make Forgelet useful in daily programming work, not just small isolated coding tasks.

The main shift from V1 to V2:

- V1: `forge "fix this bug"`
- V2: `forge --with-browser "fix the issue I am viewing"`
- V2: `forge resume <sessionId>`
- V2: `forge memory review`
- V2: `forge diagnose "backend tests are failing"`

V2 remains primarily developer-focused. It should not yet become a general life assistant.

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

Start with a small browser bridge or MCP browser provider that only exposes read-current-page tools. Avoid full browser automation until later.

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

### 3. Project Memory Review and Curation

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

### 4. Diagnose Mode

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

### 5. Better Code Context

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

### 6. Richer Plan and Review Loop

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

Keep small tasks automatic. Require plan approval for broad refactors or high-risk file sets.

### 7. Provider and Cost Improvements

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
- Full external plugin marketplace
- Vector memory as a default dependency
- Multi-agent orchestration as the default architecture
- Cloud-hosted personal sync

## V2 Success Standard

Forgelet V2 succeeds when it can handle this daily workflow:

1. User opens a GitHub issue or API doc in the browser.
2. User runs `forge --with-browser "implement this"`.
3. Forgelet reads the browser page as a context attachment.
4. Forgelet inspects the local repo.
5. Forgelet creates a plan and executes safe steps.
6. Forgelet applies a focused patch.
7. Forgelet runs targeted tests.
8. Forgelet updates trace and suggests memory updates.
9. User can later run `forge explain <sessionId>` or `forge resume <sessionId>`.

## V2 Implementation Issues

### V2 Issue 1: Add browser context attachment interface

Implement browser-origin `ContextAttachment` support without connecting a real browser yet.

Acceptance criteria:

- `source: "browser"` attachments are accepted.
- Trace records browser source metadata.
- Prompt rendering labels browser content clearly.

### V2 Issue 2: Implement read-only browser provider

Add a read-only provider for current page URL, title, selected text, and main text.

Acceptance criteria:

- `forge browser read-current` prints current page metadata.
- `forge --with-browser "<task>"` attaches page content to a task.
- No browser mutation tools exist yet.

### V2 Issue 3: Implement session resume

Allow Forgelet to resume from a prior trace.

Acceptance criteria:

- `forge resume <sessionId>` loads prior trace.
- User sees previous task, status, changed files, and last summary.
- Continued session writes a linked trace event.

### V2 Issue 4: Add project memory workflow

Add memory show/suggest/accept commands.

Acceptance criteria:

- Forgelet can suggest memory updates from a trace.
- User approval is required before writing memory.
- Memory entries are concise and editable.

### V2 Issue 5: Add diagnose mode

Add a structured debugging workflow.

Acceptance criteria:

- Diagnose mode reproduces or inspects failure before patching.
- Final summary includes root cause.
- Tests verify the diagnose state machine with mock tools.

### V2 Issue 6: Add test discovery and workspace summary tools

Improve repo awareness with static discovery tools.

Acceptance criteria:

- Forgelet can list package scripts.
- Forgelet can suggest targeted test commands.
- Forgelet can summarize project layout.

### V2 Issue 7: Add model pricing registry and model list/test commands

Make provider setup and cost more visible.

Acceptance criteria:

- `forge models list` shows configured models.
- `forge models test <modelId>` runs a minimal smoke test.
- Final summaries include model IDs and estimated cost.

## V3: Personal Agent Platform

### V3 Goal

V3 evolves Forgelet from a developer workbench into a local-first personal agent platform. It should still be excellent for coding, but it can also help with learning, planning, personal knowledge, and routine life/work workflows.

The main shift from V2 to V3:

- V2: developer assistant with browser context
- V3: personal agent platform with extensible tools, multiple surfaces, and curated memory

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

1. Local web UI for sessions, traces, memory, and settings
2. Browser extension for current-page context
3. Editor integration only if CLI workflows prove limiting
4. Desktop app if notifications/background tasks become important

**Important rule**

The CLI should remain first-class. UI surfaces should talk to the same core engine.

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

### 5. Stronger Memory Architecture

**Goal**

Support both project-specific and personal memory safely.

**Memory layers**

```text
Project memory: .forgelet/memory.md
Global user memory: ~/.forgelet/memory.md
Session traces: .forgelet/sessions/*.jsonl
Knowledge library: user-approved notes and sources
Optional vector index: derived cache, rebuildable
```

**Memory principles**

- User can inspect all durable memory.
- User can edit/delete memory.
- Memory writes require approval or configured rules.
- Memory includes provenance.
- Embeddings/vector stores are caches, not source of truth.

### 6. Workflow Graphs and Skills

**Goal**

Move beyond a single generic loop for workflows that benefit from structure.

**Examples**

```text
coding bugfix workflow
diagnose workflow
PR review workflow
learning workflow
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

### 7. Controlled Browser Automation

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

### 8. Collaboration and Review Modes

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
forge ui
forge browser act "<task>"
forge learn --context article.md "teach this to me"
forge notes search "agent memory"
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
6. Forgelet drafts a follow-up task/reminder.
7. Forgelet suggests durable memory updates.
8. User can review the complete trace in CLI or local UI.
9. No external action is taken without permission.

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

### Epic 4: Browser Extension or Bridge

- Current page context
- Selected text capture
- Source metadata
- Optional read-only screenshot
- Later: controlled actions

### Epic 5: Personal Knowledge Layer

- Source-linked notes
- Learning summaries
- Search
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

## Roadmap Ordering Recommendation

### After V1, build V2 in this order

1. Browser context attachment foundation
2. Read-only current-page browser provider
3. Session resume
4. Project memory review workflow
5. Diagnose mode
6. Workspace summary and test discovery tools
7. Model pricing registry and model diagnostics

### After V2, build V3 in this order

1. Local web UI for traces/config/memory
2. MCP integration for external tools
3. Plugin runtime
4. Personal knowledge layer
5. Browser extension bridge
6. Workflow graph engine
7. Permissioned personal tools
8. Controlled browser automation

## Design Risks

### Risk: Scope creep into a generic assistant

Mitigation:

- Keep V2 developer-focused.
- Add life/learning tools only after tool registry, permission, trace, and memory are solid.

### Risk: Browser automation creates unsafe behavior

Mitigation:

- V2 browser support is read-only.
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
6. Every run produces an inspectable trace.
7. Memory writes are curated and auditable.
8. External context is represented as structured attachments.
9. Cost and token use stay visible.
10. Learning/explainability remains part of the product, not an afterthought.
