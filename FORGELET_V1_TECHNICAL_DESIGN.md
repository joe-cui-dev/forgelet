# Forgelet V1 Technical Design

## 1. Goal

Forgelet is a local-first TypeScript/Node.js CLI coding agent. V1 focuses on programmer workflows: a user gives Forgelet a small coding task, and Forgelet can inspect the current repository, search and read files on demand, apply patches, run tests, inspect diffs, and return a concise summary.

The long-term direction is a personal agent platform. Because of that, V1 should keep the core abstractions open enough to later support browser context, learning materials, life/work tools, MCP, and external plugins.

## 2. V1 Scope

V1 must support:

```bash
forge "fix this bug"
forge --context issue.md "implement this issue"
forge --model deepseek-v4-pro "fix the failing test"
forge config get
forge config set defaultModel deepseek-v4-pro
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
```

V1 does not include:

- Interactive chat mode
- Task resume
- External plugin loading
- Browser reading
- Automatic commit, push, or deploy
- Multi-agent collaboration
- Vector database memory

## 3. Core Architecture

Forgelet uses a single-agent ReAct loop with lightweight stage constraints.

Stages:

```text
intake  -> understand task, load config, create session
plan    -> create a short visible plan
work    -> tool loop: search/read/patch/run/git
review  -> inspect diff, run verification, judge completion
final   -> summarize outcome, cost, risks, trace path
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
```

The loop should not directly depend on a specific model vendor, shell command implementation, file operation, or trace storage format.

## 4. Repository Structure

```text
forgelet/
  src/
    cli/
    agent/
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

- Global default model is configurable.
- CLI `--model` overrides the default.
- DeepSeek V4 Pro is the low-cost primary candidate.
- A fallback model can be configured for provider failures or unsupported capabilities.

Example global defaults:

```json
{
  "defaultModel": "deepseek-v4-pro",
  "fallbackModel": "gpt-5",
  "cheapModel": "deepseek-v4-flash"
}
```

## 6. Tool System

V1 uses an internal Tool Registry. It does not support external plugins yet.

```ts
interface ToolDefinition {
  name: string;
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

The agent loop should only talk to `ToolRegistry`, not directly to individual tool implementations. Future browser, MCP, calendar, notes, and email tools can be added as tool providers behind the same registry.

## 7. Permissions

Default permission strategy:

- Allow search, file reads, `git status`, and `git diff`.
- Allow editing files inside the current workspace.
- Allow commands listed in project `safeCommands`.
- Require confirmation for dependency installation, network requests, cross-workspace writes, commit, push, and deploy.
- Strongly confirm or reject destructive commands such as `rm -rf`, `git reset --hard`, and edits to secret files.

Interface:

```ts
interface PermissionPolicy {
  decide(request: ToolRequest): Promise<PermissionDecision>;
}
```

The permission layer should classify risk before a tool executes. Permission decisions must be written to the session trace.

## 8. Configuration

Forgelet uses global plus project configuration.

Global config: `~/.forgelet/config.json`

```json
{
  "defaultModel": "deepseek-v4-pro",
  "fallbackModel": "gpt-5",
  "cheapModel": "deepseek-v4-flash",
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

## 9. Context Attachments

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

## 10. Trace and Sessions

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
- `final_summary`

`forge explain <sessionId>` should read the trace and generate a learning-oriented summary: stages, important decisions, tool usage, failed attempts, retries, verification, and cost.

## 11. Budget Control

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

## 12. Planning

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

## 13. Testing Strategy

Automated tests should cover:

- Global plus project config merge
- Model selection and CLI override
- Permission decisions
- Dangerous command classification
- Tool registry dispatch
- Agent loop with mock model tool calls
- Trace write/read behavior
- `--context <file>` attachment loading
- Budget interruption

Real model calls should be manual smoke tests, not default CI tests.

## 14. Documentation

V1 documentation should include:

```text
README.md
ARCHITECTURE.md
docs/adr/
  0001-local-cli-first.md
  0002-react-loop-with-stage-constraints.md
  0003-provider-adapter-model-client.md
  0004-permission-policy.md
```

The docs should explain both how to use Forgelet and why its agent architecture works the way it does.

## 15. Packaging

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

## 16. Milestones

### Milestone 1: MVP-B Coding Agent Loop

Deliver a working local coding agent loop:

- `forge "<task>"`
- CLI skeleton
- Config loading
- Provider adapter skeleton
- Tool Registry
- Permission policy
- Search/read/patch/run/git tools
- JSONL trace
- Mock model loop tests

### Milestone 2: MVP-C Learning and Memory Layer

Add the learning and recall layer:

- `.forgelet/memory.md`
- `--context <file>`
- `forge explain <sessionId>`
- Cost summary
- Budget limits
- README
- ARCHITECTURE.md
- ADRs

## 17. First Success Standard

Forgelet V1 succeeds when it can run in a real TypeScript repository and complete a small bugfix:

1. User runs `forge "fix a known failing test"`.
2. Forgelet searches and reads relevant code.
3. Forgelet applies a minimal patch inside the current workspace.
4. Forgelet runs a targeted test successfully.
5. Forgelet reviews the diff.
6. Forgelet outputs changed files, verification commands, remaining risks, estimated cost, and trace path.
7. Forgelet does not perform high-risk actions without authorization.
