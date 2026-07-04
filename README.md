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

Model-backed Sessions currently use DeepSeek routes. Copy `.env.example` to `.env` and set `DEEPSEEK_API_KEY`.

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

`npm run smoke:writing-artifacts` runs a real prompt-only Creative Writing
Workflow, verifies that it creates `.forgelet/writing/*.md` and
`.forgelet/sessions/*.jsonl`, then checks `forge write artifacts list` and
`forge write artifacts show <sessionId>` without creating extra Session Traces.

`npm run smoke:learning` runs a real Learning Workflow smoke test with
`fixtures/learning/article.md`. It validates Learning Pack structure and Trace
evidence, and asserts that the Session does not write `.forgelet/knowledge/`.

`npm run smoke:knowledge-notes` runs the Learning smoke path, then promotes the
completed Learning Session with `forge notes create --scope project`, and checks
that `forge notes search --scope project` can find the accepted Markdown note.

## Coding Workflow

By default, Forgelet creates a model-backed read-only Coding Session. Read-only Sessions can search, read files, inspect git status/diff, update the Session plan, and write Trace evidence.

```bash
forge code "inspect this repo"
```

Use `--preview` to inspect the route, budget, read scope, and capabilities without calling a model or creating a Session or Trace.

```bash
forge code --preview --budget 0.10 "inspect this repo and summarize the CLI entrypoint"
```

For a narrow dogfood run, repeat `--allow-read` with workspace-relative file or directory paths. Directories allow their descendants; entries are literal paths, not globs.

```bash
forge \
  code \
  --allow-read README.md \
  --allow-read src/workflows \
  "summarize the workflow"
```

The resulting Session Read Scope filters workspace search/list and Git status/diff results, and denies direct reads outside the scope. It applies only to that Session. Explicit `--context` attachments remain available to the model but do not grant tool access to their paths.

Use `--act` only when you want the Coding Workflow to request confirmed file edits and configured commands.

```bash
forge code --act --budget 0.25 "fix the small failing test"
```

Actionable Sessions may request:

- `apply_patch` for ordinary workspace file edits
- `run_command` for exact configured `safeCommands`

Each patch or command goes through Forgelet's Permission Policy and interactive approval. Forgelet does not stage, commit, push, deploy, install dependencies, or run unconfigured commands in V1.

## Writing Workflow

The Writing Workflow uses context and model text generation without workspace, git, patch, or command tools.

```bash
forge write --context draft.md "revise this for clarity"
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
Pack for prompt-only briefs or a Revision Pack for attached source text. Model-backed
writing Sessions also save the drafted or revised prose to `.forgelet/writing/`
by default without overwriting context attachments.

```bash
forge write --creative --style vivid "write a rain-soaked convenience store scene"
forge write --creative --style vivid --context scene.md "revise this scene"
forge write --creative --style vivid --continue .forgelet/writing/chapter-1.md "continue the next chapter"
forge write artifacts list
forge write artifacts show .forgelet/writing/chapter-1.md
forge write artifacts show <sessionId> --full
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

Continue a saved Markdown Writing Artifact with `--continue`. The selected
artifact is used as the prose source, repeated `--context` attachments are
treated as supporting references, and the result is a new Draft Pack saved under
`.forgelet/writing/` without overwriting the source artifact.

Use the project-local Writing Artifact Catalog to find saved outputs and preview
their prose without creating a Session or calling a model. The catalog is derived
from `.forgelet/sessions/*.jsonl` and `.forgelet/writing/*.md`; it marks missing
trace-backed files and untracked local Markdown artifacts explicitly.

Long-form Writing Project continuity is a later V2 design step; it is not a
precondition for short-form creative rewriting.

## Learning Workflow

The Learning Workflow turns explicit source material into a source-linked
Learning Pack. Learning Sessions do not write Knowledge Library notes during
the Session.

```bash
forge learn --context paper.md "teach me the core ideas"
forge learn --with-browser "turn this article into study notes"
forge learn --preview --context paper.md "teach me the core ideas"
```

`forge learn` requires at least one source: `--context` or `--with-browser`.
It returns a Learning Pack with `Summary`, `Key Concepts`, `Source Links`,
`Open Questions`, and `Review Prompts`. Model-backed learning Sessions record
Session output and Trace evidence under `.forgelet/sessions/`, including source
attachment metadata. They do not write `.forgelet/knowledge/`.

## Knowledge Notes

Knowledge Notes are explicit promotions from completed, source-backed Learning
Sessions into project Markdown files under `.forgelet/knowledge/`.

```bash
forge notes create --scope project --from-session <learning-session-id>
forge notes create --scope project --from-session <learning-session-id> --title "Custom title"
forge notes search --scope project "workflow graph design"
forge notes search --scope project --limit 5 "workflow graph design"
```

`forge notes create` deterministically promotes the Learning Pack recorded in
`final_summary.summary`; it does not call a model, create a new Session, mutate
the source Trace, or ask for a second confirmation. Re-running creation for the
same Session fails instead of overwriting the existing note.

`forge notes search` performs local case-insensitive Markdown search over
accepted project notes. Personal scope, JSON output, embeddings, and persistent
indexes are not available in this slice.

## Context Attachments

Attach text context with `--context`.

```bash
forge code --context issue.md "implement this issue"
forge write --context draft.md "revise this"
```

V1 supports `.md`, `.txt`, `.log`, and `.json`. Trace records attachment metadata, size, hash, and preview; full attachment content is sent only to the active model prompt within limits.

## Browser Context

Attach the most recent browser snapshot with `--with-browser`.

```bash
forge browser read-current
forge browser install-host --extension-id <chrome-extension-id>
forge code --with-browser "implement the issue I am viewing"
forge write --with-browser "turn this article into an outline"
```

Forgelet reads a short-lived snapshot from `~/.forgelet/browser/current-page.json`. The snapshot can include URL, title, capture time, selected text, extracted main text, and optional screenshot path metadata. `--with-browser` prefers selected text and falls back to main text. Before a Session runs, Forgelet prints the browser source URL, title, capture time, content kind, and byte count.

Browser context is read-only. It becomes a `ContextAttachment` with `source: "browser"` and `trustLevel: "external"`. Trace records attachment metadata, hash, size, and preview; it does not persist full page text. The local Chrome producer is an unpacked extension plus a Native Messaging host. Build the project, load `dist/browser-extension/` in Chrome, copy the unpacked extension id, then run `forge browser install-host --extension-id <chrome-extension-id>`.

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

Plain resume is model-backed and read-only by default. `--act` enables the same actionable Coding Workflow capability path as `forge code --act`: prior evidence is inherited, but every new patch or command requires approval in the child Session. Final audit output separates inherited Forgelet changes from files changed by the continuation.

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
forge code --model deepseek-v4-pro "inspect this repo"
```

Project-level `safeCommands`, `testCommands`, `commandTimeoutMs`, `maxPatchBytes`, and `activeContext` overrides belong in `.forgelet/config.json`. The active observation target defaults to 16384 UTF-8 bytes and controls best-effort compaction of old model-visible tool results; it is not a provider token limit or a Session stop budget. Observation Digest excerpts default to 2048 UTF-8 bytes per compacted result.

## V1 Boundaries

Forgelet V1 does not include interactive chat, external plugin loading, browser automation, browser extension packaging, document editor integration, image generation, automatic commit/push/deploy, multi-agent collaboration, vector database memory, Writing Workflow resume, or arbitrary resume-time model/budget overrides.
