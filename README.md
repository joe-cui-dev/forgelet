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

`npm run smoke:writing` runs a real Creative Writing Workflow smoke test. It
builds the CLI, runs from the project workspace with
`fixtures/writing/scene.md`, and checks only the Revision Pack
structure and Trace evidence. It writes the Session Trace under the project's
`.forgelet/sessions/` directory and prints the Trace path for review; it does
not score prose quality or write revised prose back to the repo.

## Coding Workflow

By default, Forgelet creates a scaffolded Session and writes a JSONL Trace without calling a model.

```bash
forge "inspect this repo"
```

Use `--live` for a real DeepSeek-backed read-only Session. Read-only Sessions can search, read files, inspect git status/diff, update the Session plan, and write Trace evidence.

```bash
forge --live --budget 0.10 "inspect this repo and summarize the CLI entrypoint"
```

For a narrow dogfood run, repeat `--allow-read` with workspace-relative file or directory paths. Directories allow their descendants; entries are literal paths, not globs.

```bash
forge --live \
  --allow-read README.md \
  --allow-read src/workflows \
  "summarize the workflow"
```

The resulting Session Read Scope filters workspace search/list and Git status/diff results, and denies direct reads outside the scope. It applies only to that Session. Explicit `--context` attachments remain available to the model but do not grant tool access to their paths.

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

Use `--creative` with an explicit style for short-form creative writing. The
Creative Brief can stand alone for original drafting, or it can be combined with
one or more `--context` attachments for revision. The command prints a Draft
Pack for prompt-only briefs or a Revision Pack for attached source text. Live
writing Sessions also save the drafted or revised prose to `.forgelet/writing/`
by default without overwriting context attachments.

```bash
forge write --live --creative --style vivid "write a rain-soaked convenience store scene"
forge write --live --creative --style vivid --context scene.md "revise this scene"
```

Built-in styles are `vivid`, `tight`, `literary`, and `plain`.

Prompt-only creative drafting output is shaped as:

```text
Draft
...
```

Creative writing with `--context` output is shaped as:

```text
Critique
...

Revision
...

Alternatives
1. ...
2. ...

Notes
...
```

Long-form Writing Project continuity is a later V2 design step; it is not a
precondition for short-form creative rewriting.

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

Resume a Coding Workflow Session to create a new immutable child Session with compact Continuation Context from its lineage.

```bash
forge resume <sessionId> "continue from the prior findings"
forge resume <sessionId> --act "finish the fix and run the configured test"
```

Plain resume is live and read-only by default. `--act` enables the same actionable Coding Workflow capability path as `forge --live --act`: prior evidence is inherited, but every new patch or command requires approval in the child Session. Final audit output separates inherited Forgelet changes from files changed by the continuation.

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
forge config set activeContext.observationDigestPreviewBytes 2048
forge config set providers.deepseek.apiKeyEnv DEEPSEEK_API_KEY
forge config set providers.openai.apiKeyEnv OPENAI_API_KEY
forge config set providers.anthropic.apiKeyEnv ANTHROPIC_API_KEY
```

Model defaults and routing are defined in `src/config/index.ts`. Use `--model` for a one-run override:

```bash
forge --live --model deepseek-v4-pro "inspect this repo"
```

Project-level `safeCommands`, `testCommands`, `commandTimeoutMs`, `maxPatchBytes`, and `activeContext` overrides belong in `.forgelet/config.json`. The active observation target defaults to 16384 UTF-8 bytes and controls best-effort compaction of old model-visible tool results; it is not a provider token limit or a Session stop budget. Observation Digest excerpts default to 2048 UTF-8 bytes per compacted result.

## V1 Boundaries

Forgelet V1 does not include interactive chat, external plugin loading, browser reading, document editor integration, image generation, automatic commit/push/deploy, multi-agent collaboration, vector database memory, Writing Workflow resume, or arbitrary resume-time model/budget overrides.
