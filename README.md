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
forge code --write-scope src --write-scope docs "add a changelog entry"
forge code --write-scope . --allow-command "npm test" "run the tests and fix failures"
forge queue
forge decide <sessionId>
```

Repeating `--write-scope` (workspace-relative path prefixes, or `.` for the whole workspace) declares a Coding Session's Effect Envelope; this is the only switch into background semantics — there is no separate `--background` flag. Within the envelope, confirm-tier file edits and commands auto-approve and are cited in the Trace instead of prompting; the command allowlist defaults to every configured safe command unless narrowed with `--allow-command`. An action outside the envelope pauses the Session in place (same Session id, same Trace) and exits the process instead of prompting. Use `forge queue` to list paused Sessions and their pending action, and `forge decide <sessionId>` (or `forge decide` with no id when exactly one Session is paused) to approve once, deny once, approve-and-widen the envelope, or stop with a wrap-up turn. `--max-wall-clock-ms` and `--max-turns` override the wall-clock and model-turn ceilings for one run.

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

## Chrome Browser Workbench

The Browser Workbench summarizes the current page with one toolbar click. It opens a Side Panel and starts one answer-once Learning Session in an explicitly approved local workspace; it cannot run Coding or Writing Workflows, or select a model, path, or command from the browser.

### Install

Build Forgelet and make the checkout's CLI available. The following commands assume a macOS Chrome installation and are run from the Forgelet checkout:

```bash
npm install
npm run build
npm link
```

Approve the workspace where Browser Workbench Sessions should run (and where its `.env` contains `DEEPSEEK_API_KEY`), then make that profile the browser default:

```bash
cd /path/to/approved-workspace
forge browser profiles approve --name "My workspace"
forge browser profiles list
forge browser profiles set-default <profile-id>
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the built extension directory:

```text
/path/to/forgelet/dist/browser-extension
```

Copy the extension ID Chrome displays. Back in the Forgelet checkout, register the Native Messaging host for that ID:

```bash
cd /path/to/forgelet
forge browser install-host --extension-id <chrome-extension-id>
```

`install-host` points Chrome at this checkout's built Native Host, so run it after `npm run build` and from the checkout. It does not approve a workspace. If Chrome assigns a new ID after you reload or reinstall the unpacked extension, run `install-host` again with the new ID.

### Use

Open a page Chrome allows extensions to inspect, then click the Forgelet toolbar icon. The Side Panel displays Session status, Session ID, Trace path, and the final Learning Pack summary. Use **Stop** to cancel an active Session; closing the Side Panel only detaches its presentation and does not cancel work.

Chrome internal pages such as `chrome://extensions` and other browser-restricted pages cannot be captured. Open an ordinary HTTP(S) page instead. After a source update, run `npm run build` and press Chrome's reload button for the extension in `chrome://extensions`.

The older read-only browser snapshot path remains available for CLI Sessions:

```bash
forge browser read-current
forge code --with-browser "summarize this page"
```

Browser context is read-only and user-approved. Both Browser Workbench and the compatibility snapshot path record source metadata, hash, size, and preview instead of complete page text in the Trace.

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

Project config lives at `.forgelet/config.json`. Durable Memory is user-approved; see [Project Memory Review](#project-memory-review) below for the full review and decision surface.

## Project Memory Review

```bash
forge memory list
forge memory list --all
forge memory show <suggestionId>
forge memory accept <suggestionId>
forge memory reject <suggestionId>
```

Project Memory Review is guided, deterministic, and model-free: no command in this surface starts a model client, a Workflow, a Session, or a Session Trace. A Memory Suggestion only becomes Durable Memory when the user explicitly runs `accept`; nothing is written automatically.

`forge memory list` is a deterministic, model-free review queue over project-scope Memory Suggestions: it shows only actionable items — `proposed` suggestions and `accepted (unwritten)` Memory Write Gaps — in append order, each with a plain-language state, a one-line preview, and the next command to run. `--all` adds accepted and rejected history in the same layout. Every displayed state is derived from the append-only `.forgelet/memory-suggestions.jsonl` and Memory Decision Log (`.forgelet/memory-decisions.jsonl`); before the first memory operation a Compatibility Import converts recoverable legacy suggestion status into decision evidence without rewriting existing records or Durable Memory blocks.

`forge memory show <suggestionId>` is the deterministic, model-free evidence view: it presents the proposed guidance, its stored provenance, current Trace Corroboration, and — while a write remains possible — the exact Rendered Memory Block, hash, byte count, and currently resolved Durable Memory destination. It ends with the user's explicit next choice: accept or reject.

`forge memory accept <suggestionId>` and `forge memory reject <suggestionId>` record the user's explicit decision as the commit point in the Memory Decision Log, then return a concise receipt naming the outcome (`decided`, `repeated`, or `repaired`) and, for an acceptance, the Durable Memory path, byte count, and hash actually written. Accepting an already-accepted suggestion whose write is missing (a Memory Write Gap) repairs it idempotently instead of duplicating the block; deciding an already-decided suggestion the same way reports `repeated` with no new evidence appended; deciding it the other way is a conflict error.

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
npm run smoke:memory-review
npm run smoke:browser-workbench
```

Use `npm run smoke:deepseek` as the cheapest real-provider check. The workflow smoke scripts validate public CLI behavior, Trace evidence, and saved artifacts without scoring model prose quality. `npm run smoke:memory-review` is the exception: it drives `forge memory list/show/accept/reject` in a scratch workspace against a versioned suggestion and representative legacy evidence, and proves the path stays model-free by never providing a provider API key.

`npm run smoke:browser-workbench` drives the built Native Host protocol in a scratch workspace with a deterministic fake model. It validates approved-profile launch, Session-ready ordering, normalized Learning Pack completion, and Trace page-body privacy; it is not a substitute for manual unpacked-extension dogfood.

## Docs

- [AGENTS.md](./AGENTS.md): agent reading guide and source map
- [CONTEXT.md](./CONTEXT.md): core glossary only
- [ROADMAP.md](./ROADMAP.md): current direction and next slices
- [docs/adr/](./docs/adr/): durable architectural decisions
