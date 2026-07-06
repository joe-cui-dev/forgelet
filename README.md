# Forgelet

Forgelet is a local-first personal Agent Kernel with a CLI as its first surface. It runs auditable Coding, Writing, Learning, browser-context, and knowledge workflows from the current workspace.

## Setup

Requirements: Node.js 24, npm, and Git.

```bash
nvm install
nvm use
npm install
npm run build
npm test
```

Model-backed Sessions currently use DeepSeek routes. Copy `.env.example` to `.env` and set `DEEPSEEK_API_KEY`.

```bash
cp .env.example .env
npm run smoke:deepseek
```

## Common Commands

```bash
forge code "inspect this repo"
forge code --preview --budget 0.10 "summarize the CLI entrypoint"
forge code --allow-read README.md --allow-read src/workflows "summarize the workflow"
forge code --act --budget 0.25 "fix the small failing test"
```

`forge code` starts a model-backed Coding Session. It can read workspace files, inspect Git status/diff, update the Session plan, and write Trace evidence. Add `--act` only when you want the Coding Workflow to request confirmed file edits and configured commands.

```bash
forge write --context draft.md "revise this for clarity"
forge write --with-browser "turn this article into an outline"
forge write --creative --style vivid "write a rain-soaked convenience store scene"
forge write --creative --style vivid --context scene.md "revise this scene"
forge write --creative --style vivid --continue .forgelet/writing/chapter-1.md "continue the next chapter"
forge write projects create my-novel
forge write --project my-novel --creative --style vivid "write chapter one"
forge write --project my-novel --creative --style vivid "continue from the project head"
forge write --project my-novel --creative --style vivid --continue .forgelet/writing/chapter-1.md "revise chapter one"
forge write artifacts list
forge write artifacts show <sessionId> --full
forge write artifacts search --limit 5 "chapter"
```

Writing Sessions use model text generation without workspace, Git, patch, or command tools. Model-backed writing saves drafted or revised prose under `.forgelet/writing/` with local timestamp-prefixed filenames. Creative Style Preset keys are `plain`, `vivid`, `tight`, `literary`, `cinematic`, `minimal`, `lyrical`, `noir`, `warm`, `sharp`, `sensual`, and `ardent`. Project-local preset definitions live in `.forgelet/style-presets.local.json`; this file is ignored by Git, and Sessions/Traces record only the selected preset key. If the local file is missing, Forgelet uses a public fallback prompt that does not contain private preset prose.

Writing Projects group long-form Writing Artifacts in `.forgelet/writing/projects/<slug>.json`. `forge write --project <slug>` continues from the manifest head by default, appends the new artifact to the manifest, and advances the head only when the Session continued from the current head. Use `--project` with `--continue <member.md>` to revise an older member without moving the head. To enroll older artifacts, edit the manifest by hand; unknown projects and non-member `--continue` paths are errors.

```json
{
  "vivid": {
    "label": "Private vivid label.",
    "aim": "Private vivid aim.",
    "instructions": [
      "Private instruction one.",
      "Private instruction two.",
      "Private instruction three."
    ],
    "avoid": ["Private avoid one.", "Private avoid two."],
    "revisionFocus": [
      "Private revision focus one.",
      "Private revision focus two."
    ]
  }
}
```

Prompt-only creative drafting returns:

```text
Draft
...
```

Context-backed creative revision returns:

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

```bash
forge learn --context paper.md "teach me the core ideas"
forge learn --with-browser "turn this article into study notes"
forge learn --preview --context paper.md "teach me the core ideas"
forge notes create --scope project --from-session <learning-session-id>
forge notes search --scope project --limit 5 "workflow graph design"
```

Learning Sessions require explicit source material from `--context` or `--with-browser`. They return a Learning Pack with `Summary`, `Key Concepts`, `Source Links`, `Open Questions`, and `Review Prompts`. Knowledge Notes are explicit project-scope promotions from completed, source-backed Learning Sessions into `.forgelet/knowledge/`.

```bash
forge browser read-current
forge browser install-host --extension-id <chrome-extension-id>
forge code --with-browser "summarize this page"
```

Browser context is read-only and user-approved. The Chrome extension plus Native Messaging host writes a short-lived current-page snapshot; Forgelet consumes it as a browser-sourced Context Attachment and records metadata, hash, size, and preview instead of full page text.

## Sessions

Every model-backed run writes a Trace under `.forgelet/sessions/`. New Trace files use a local timestamp prefix such as `YYYYMMDD_HHMMSS_<sessionId>.jsonl`; the Session id remains the stable CLI handle.

```bash
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
forge resume <sessionId> "continue the task"
forge resume <sessionId> --act "continue the fix"
forge code --debug "inspect this repo"
forge debug show <sessionId>
forge debug show <sessionId> --full
```

`forge resume` creates a child Session Continuation. Prior evidence can shape the new Active Context, but approvals and writes do not inherit.

`--debug` is available for model-backed Session commands: `forge code`, `forge write`, `forge learn`, and `forge resume`. It writes an explicit local Debug Transcript under `.forgelet/debug/<sessionId>.jsonl`; this directory is ignored by Git. Debug Transcripts are for diagnosis and may contain full prompts, context, model output, tool inputs, and tool observations. Trace records only the Debug Transcript path, hash, byte count, and completion status.

## Configuration

```bash
forge config get
forge config set memoryFile .forgelet/custom-memory.md
forge config set activeContext.maxObservationBytes 16384
forge config set providers.deepseek.apiKeyEnv DEEPSEEK_API_KEY
```

Project config lives at `.forgelet/config.json`. Durable Memory is user-approved; suggestions can be reviewed with `forge memory suggest <sessionId>` and accepted with `forge memory accept <suggestionId>`.

## Validation

```bash
npm run typecheck
npm test
npm run build
npm run smoke:deepseek
npm run smoke:writing
npm run smoke:writing-artifacts
npm run smoke:learning
npm run smoke:knowledge-notes
```

Use `npm run smoke:deepseek` as the cheapest real-provider check. The workflow smoke scripts validate public CLI behavior, Trace evidence, and saved artifacts without scoring model prose quality.

## Docs

- [AGENTS.md](./AGENTS.md): agent reading guide and source map
- [CONTEXT.md](./CONTEXT.md): core glossary only
- [ROADMAP.md](./ROADMAP.md): current direction and next slices
- [docs/adr/](./docs/adr/): durable architectural decisions
