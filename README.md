# Forgelet

Forgelet is a local-first personal Agent Kernel with a CLI as its first surface.
V1 proves the kernel through a coding workflow and a lightweight writing workflow.

## Requirements

- Node.js 24
- npm
- Git, for workspace status and patch workflows

```bash
nvm install
nvm use
npm install
npm run build
npm test
```

## DeepSeek Setup

Live Sessions currently use DeepSeek routes. Copy `.env.example` to `.env` and set `DEEPSEEK_API_KEY`.

```bash
cp .env.example .env
npm run smoke:deepseek
```

`npm run smoke:deepseek` is the cheapest real-provider check. It verifies API access and tool-call wiring without running a full Session.

## Coding Workflow

By default, Forgelet creates a scaffolded Session and writes a JSONL Trace without calling a model.

```bash
forge "inspect this repo"
```

Use `--live` for a real DeepSeek-backed read-only Session. Read-only Sessions can search, read files, inspect git status/diff, update the Session plan, and write Trace evidence.

```bash
forge --live --budget 0.10 "inspect this repo and summarize the CLI entrypoint"
```

Use `--live --act` only when you want the Coding Workflow to request confirmed file edits and configured commands.

```bash
forge --live --act --budget 0.25 "fix the small failing test"
```

Actionable Sessions may request:

- `apply_patch` for ordinary workspace file edits
- `run_command` for exact configured `safeCommands`

Each patch or command goes through Forgelet's Permission Policy and interactive approval. Forgelet does not stage, commit, push, deploy, install dependencies, or run unconfigured commands in V1.

## Writing Workflow

The Writing Workflow uses context and model text generation without workspace, git, patch, or command tools.

```bash
forge write --live --context draft.md "revise this for clarity"
```

V1 writing output is shaped as:

```text
Critique
...

Revision
...

Notes
...
```

## Context Attachments

Attach text context with `--context`.

```bash
forge --live --context issue.md "implement this issue"
forge write --live --context draft.md "revise this"
```

V1 supports `.md`, `.txt`, `.log`, and `.json`. Trace records attachment metadata, size, hash, and preview; full attachment content is sent only to the active model prompt within limits.

## Sessions, Explain, and Memory

Every run writes a Trace under `.forgelet/sessions/`.

```bash
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
```

Actionable Coding Sessions include a structured audit with Forgelet-changed files, pre-existing workspace changes, verification commands, kernel-observed risks, model turns, estimated cost, and Trace path.

Forgelet can suggest Durable Memory from high-confidence Session evidence, but it writes memory only after explicit acceptance.

```bash
forge memory suggest <sessionId>
forge memory accept <suggestionId>
```

Accepted memory is appended to the configured memory file, defaulting to `.forgelet/memory.md`.

## Configuration

Inspect merged defaults, global config, and project config:

```bash
forge config get
```

V1 has a narrow `config set` surface for user-level values:

```bash
forge config set memoryFile .forgelet/memory.md
forge config set activeContext.maxObservationBytes 16384
forge config set providers.deepseek.apiKeyEnv DEEPSEEK_API_KEY
forge config set providers.openai.apiKeyEnv OPENAI_API_KEY
forge config set providers.anthropic.apiKeyEnv ANTHROPIC_API_KEY
```

Model defaults and routing are defined in `src/config/index.ts`. Use `--model` for a one-run override:

```bash
forge --live --model deepseek-v4-pro "inspect this repo"
```

Project-level `safeCommands`, `testCommands`, `commandTimeoutMs`, `maxPatchBytes`, and `activeContext.maxObservationBytes` overrides belong in `.forgelet/config.json`. The active observation target defaults to 16384 UTF-8 bytes and controls best-effort compaction of old model-visible tool results; it is not a provider token limit or a Session stop budget.

## V1 Boundaries

Forgelet V1 does not include interactive chat, Session resume, external plugin loading, browser reading, document editor integration, image generation, automatic commit/push/deploy, multi-agent collaboration, or vector database memory.
