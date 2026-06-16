# Forgelet V1 Technical Design

## 1. Goal

Forgelet is a local-first personal agent kernel with a TypeScript/Node.js CLI as its first surface. V1 focuses on a usable coding workflow plus a lightweight writing workflow skeleton. In the coding workflow, a user gives Forgelet a small repository task, and Forgelet can inspect the current repository, search and read files on demand, apply patches, run tests, inspect diffs, and return a concise summary. In the writing workflow skeleton, a user gives Forgelet text context and asks for drafting, revision, critique, or restructuring without code-specific tools.

The long-term direction is a personal agent platform. Because of that, V1 should keep the core abstractions open enough to later support browser context, learning materials, life/work tools, MCP, and external plugins.

## 2. V1 Scope

V1 must support:

```bash
forge "fix this bug"
forge --context issue.md "implement this issue"
forge write --context draft.md "revise this"
forge --model deepseek-v4-pro "fix the failing test"
forge config get
forge config set defaultModel deepseek-v4-pro
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
forge memory suggest <sessionId>
forge memory accept <suggestionId>
```

V1 does not include:

- Interactive chat mode
- Task resume
- External plugin loading
- Browser reading
- Document editor integration
- Image generation or image editing
- Automatic commit, push, or deploy
- Multi-agent collaboration
- Vector database memory

## 3. Core Architecture

Forgelet uses explicit workflow graphs with bounded ReAct nodes. The V1 coding workflow proves useful local action, and the V1 writing workflow skeleton proves the kernel can host a non-code workflow without changing its boundaries.

V1 coding workflow stages:

```text
intake   -> understand task, load config, create session
inspect  -> gather workspace and context signals
plan     -> create a short visible plan
act_loop -> bounded ReAct node for search/read/patch/run/git
verify   -> run targeted checks and inspect results
review   -> inspect diff, judge completion, decide whether more work is needed
final    -> summarize outcome, cost, risks, trace path
```

V1 writing workflow skeleton stages:

```text
intake   -> understand writing task, load text context, create session
plan     -> choose draft, revise, critique, or restructure path
act_loop -> bounded ReAct node for text-only drafting and critique
review   -> check requested tone, structure, constraints, and risks
final    -> return critique, revision, model choice, cost, and trace summary
```

The agent loop should depend only on abstractions:

```text
ModelClient
ToolRegistry
PermissionPolicy
TraceWriter
Workspace
ConfigStore
BudgetTracker
WorkflowRunner
```

The workflow runner should not directly depend on a specific model vendor, shell command implementation, file operation, or trace storage format.

## 4. Repository Structure

```text
forgelet/
  src/
    cli/
    agent/
    workflows/
    models/
      providers/
    tools/
    permissions/
    config/
    trace/
    workspace/
    context/
    budget/
  tests/
  docs/
    adr/
  README.md
  ARCHITECTURE.md
  package.json
```

Forgelet should start as a single package with domain-based modules. It should not start as a monorepo.

## 5. Model Layer

Forgelet uses a Provider Adapter architecture.

```ts
interface ModelClient {
  createTurn(input: ModelTurnInput): Promise<ModelTurnOutput>;
}

interface ModelProvider {
  id: "openai" | "anthropic" | "deepseek";
  createClient(config: ProviderConfig): ModelClient;
}
```

V1 supports:

- DeepSeek: `deepseek-v4-pro`, `deepseek-v4-flash`
- OpenAI: configurable model IDs
- Anthropic: configurable model IDs

DeepSeek may internally use an OpenAI-compatible client, but it must sit behind `DeepSeekProvider` so vendor-specific behavior does not leak into the agent loop.

Model selection rules:

- Model routing is configured by workflow and stage.
- CLI `--model` overrides routing for the run.
- DeepSeek V4 Pro is the low-cost primary candidate for coding action stages.
- DeepSeek V4 Flash is the low-cost primary candidate for writing critique and revision stages.
- Fallback and escalation models can be configured for provider failures, unsupported capabilities, or explicit review stages.
- The final summary should report which model route was selected and why.

Example global routing defaults:

```json
{
  "defaultModel": "deepseek-v4-pro",
  "fallbackModel": "gpt-5",
  "cheapModel": "deepseek-v4-flash",
  "routing": {
    "coding": {
      "default": "deepseek-v4-pro",
      "review": "deepseek-v4-pro"
    },
    "writing": {
      "default": "deepseek-v4-flash",
      "review": "deepseek-v4-flash"
    },
    "fallback": "gpt-5"
  }
}
```

## 6. Tool System

V1 uses an internal Tool Registry. It does not support external plugins yet.

```ts
interface ToolDefinition {
  name: string;
  providerId: string;
  capability: Capability;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

Built-in V1 tools:

- `list_files`
- `search_text`
- `read_file`
- `apply_patch`
- `run_command`
- `git_status`
- `git_diff`
- `update_plan`

The workflow runner should only talk to `ToolRegistry`, not directly to individual tool implementations. Future browser, MCP, calendar, notes, and email tools can be added as tool providers behind the same registry.

## 7. Permissions

Forgelet uses two permission layers:

1. Workflow capability grants decide which capabilities a workflow may request.
2. Risk tier classification decides whether the requested action is low, medium, high, or forbidden risk.
3. PermissionPolicy decides whether a specific tool call is allowed, confirmed, or denied.

Default V1 workflow grants:

- Coding workflow: `read_workspace`, `write_workspace`, `run_safe_command`, `git_read`, `update_plan`, `model_generate_text`.
- Writing workflow: `read_context`, `update_plan`, `model_generate_text`.

Default risk tiers:

- Low risk: search, file reads, browser read-only context, `git status`, `git diff`, planning, critique, and non-durable model output.
- Medium risk: editing files inside the current workspace, running configured safe commands, writing accepted knowledge notes, or accepting memory suggestions.
- High risk: dependency installation, network requests, cross-workspace writes, commits, pushes, deploys, model escalation with meaningful cost, and external app mutation.
- Forbidden risk: destructive commands such as `rm -rf`, `git reset --hard`, credential exfiltration, hidden browser scraping, and unapproved edits to secret files.

Default autonomy strategy:

- Low risk actions may proceed automatically when covered by workflow grants.
- Medium risk actions require policy checks and may require confirmation depending on workflow and project config.
- High risk actions require explicit confirmation.
- Forbidden actions are denied or strongly confirmed only when the policy explicitly allows an escape hatch.

Interface:

```ts
interface PermissionPolicy {
  decide(request: ToolRequest): Promise<PermissionDecision>;
}
```

The permission layer should classify risk before a tool executes. Risk tiers and permission decisions must be written to the session trace.

## 8. Configuration

Forgelet uses global plus project configuration.

Global config: `~/.forgelet/config.json`

```json
{
  "defaultModel": "deepseek-v4-pro",
  "fallbackModel": "gpt-5",
  "cheapModel": "deepseek-v4-flash",
  "routing": {
    "coding": {
      "default": "deepseek-v4-pro",
      "review": "deepseek-v4-pro"
    },
    "writing": {
      "default": "deepseek-v4-flash",
      "review": "deepseek-v4-flash"
    },
    "fallback": "gpt-5"
  },
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

Project config: `<repo>/.forgelet/config.json`

```json
{
  "safeCommands": ["npm test", "npm run build", "npx jest"],
  "testCommands": ["npm test", "npm run build"],
  "memoryFile": ".forgelet/memory.md"
}
```

Global config stores personal preferences and provider settings. Project config stores repository-specific commands, safety rules, and memory location.

## 9. Memory Suggestions

V1 supports user-approved memory persistence. Forgelet may generate memory suggestions from a session trace, final summary, or explain output, but it must not silently write durable memory.

```ts
interface MemorySuggestion {
  id: string;
  sourceSessionId: string;
  text: string;
  reason: string;
  status: "proposed" | "accepted" | "rejected";
}
```

Memory rules:

- `forge memory suggest <sessionId>` creates proposed memory entries from a trace.
- `forge memory accept <suggestionId>` appends an accepted entry to the configured memory file.
- Accepted memory entries must include provenance back to the source session.
- Rejected suggestions must not be reused as durable memory.
- Vector stores, embeddings, or derived indexes are caches only, not the source of truth.

## 10. Context Attachments

V1 supports `--context <file>` for text file attachments and reserves the same abstraction for future browser context.

```ts
interface ContextAttachment {
  id: string;
  source: "user" | "file" | "browser" | "clipboard" | "issue";
  title?: string;
  uri?: string;
  mimeType: string;
  content: string;
  trustLevel: "user-provided" | "workspace" | "external";
}
```

V1 file attachment rules:

- Support `.md`, `.txt`, `.log`, and `.json`.
- Accept workspace files or explicit user-provided paths.
- Write attachment metadata to trace.
- Present attachments to the model with clear source labels instead of mixing them into raw task text.

Future browser support should plug into this abstraction as a `browser` attachment source.

## 11. Trace and Sessions

Each run writes a JSONL trace:

```text
.forgelet/sessions/<sessionId>.jsonl
```

Trace event types:

- `user_task`
- `context_attachment`
- `model_turn`
- `tool_call`
- `tool_result`
- `permission_decision`
- `plan_update`
- `budget_update`
- `memory_suggestion`
- `memory_acceptance`
- `final_summary`

`forge explain <sessionId>` should read the trace and generate a learning-oriented summary: stages, important decisions, tool usage, failed attempts, retries, verification, and cost.

## 12. Budget Control

V1 includes explicit budget limits and a per-task cost summary.

Limits:

- Maximum model turns
- Maximum estimated input tokens
- Maximum estimated USD cost

Example CLI override:

```bash
forge --budget 0.25 "fix this bug"
```

Final summary should include:

```text
Model turns
Estimated input/output tokens
Estimated cost
Trace path
Changed files
Verification commands
```

If a task approaches budget, Forgelet should stop, summarize progress, and explain what remains.

## 13. Planning

V1 should show a visible plan and update it during execution.

Example:

```text
Plan
- Inspect failing test
- Locate implementation
- Patch minimal fix
- Run targeted test
- Review diff
```

Status updates should be reflected in the trace as `plan_update` events. Complex tasks may require user approval before execution, but simple small coding tasks should proceed under the configured permission policy.

## 14. Testing Strategy

Automated tests should cover:

- Global plus project config merge
- Model selection and CLI override
- Permission decisions
- Dangerous command classification
- Tool registry dispatch
- Agent loop with mock model tool calls
- Trace write/read behavior
- `--context <file>` attachment loading
- Memory suggestion and acceptance behavior
- Budget interruption

Real model calls should be manual smoke tests, not default CI tests.

## 15. Documentation

V1 documentation should include:

```text
README.md
ARCHITECTURE.md
docs/adr/
  0001-local-cli-first.md
  0002-tool-providers-and-capabilities.md
  0003-workflow-graphs-with-react-nodes.md
  0004-v1-includes-writing-workflow-skeleton.md
  0005-workflow-stage-model-routing.md
  0006-workflow-capability-grants.md
  0007-user-approved-memory-persistence.md
  0008-markdown-knowledge-library.md
  0009-local-review-ui-after-core-workflows.md
  0010-browser-context-extension-bridge-first.md
  0011-risk-tiered-autonomy.md
  0012-provider-adapter-model-client.md
  0013-permission-policy.md
```

The docs should explain both how to use Forgelet and why its agent architecture works the way it does.

## 16. Packaging

Forgelet V1 should be locally linkable but not published to npm yet.

Expected local workflow:

```bash
npm install
npm run build
npm link
forge "fix this bug"
```

`package.json` should eventually include:

```json
{
  "name": "forgelet",
  "bin": {
    "forge": "./dist/cli/index.js"
  }
}
```

## 17. Milestones

### Milestone 1: MVP-B Coding Workflow

Deliver a working local coding workflow:

- `forge "<task>"`
- CLI skeleton
- Config loading
- Provider adapter skeleton
- Tool Registry
- Permission policy
- Search/read/patch/run/git tools
- JSONL trace
- Mock model loop tests

### Milestone 2: MVP-C Writing Skeleton, Learning, and Memory Layer

Add a lightweight non-code workflow plus the learning and recall layer:

- `forge write --context <file> "<task>"`
- Text-only writing workflow skeleton
- `.forgelet/memory.md`
- `forge memory suggest <sessionId>`
- `forge memory accept <suggestionId>`
- `--context <file>`
- `forge explain <sessionId>`
- Cost summary
- Budget limits
- README
- ARCHITECTURE.md
- ADRs

## 18. First Success Standard

Forgelet V1 succeeds when it can run in a real TypeScript repository, complete a small bugfix, and demonstrate one non-code writing workflow skeleton:

1. User runs `forge "fix a known failing test"`.
2. Forgelet searches and reads relevant code.
3. Forgelet applies a minimal patch inside the current workspace.
4. Forgelet runs a targeted test successfully.
5. Forgelet reviews the diff.
6. Forgelet outputs changed files, verification commands, remaining risks, estimated cost, and trace path.
7. Forgelet does not perform high-risk actions without authorization.
8. User runs `forge write --context draft.md "revise this for clarity"`.
9. Forgelet loads the text context without workspace edit tools.
10. Forgelet returns revised text or critique plus model, cost, and trace summary.
11. User can generate a memory suggestion from a session.
12. Durable memory is written only after user acceptance.
