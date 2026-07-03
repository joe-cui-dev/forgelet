# Learning Workflow Execution Plan

Implement `forge learn` as the first source-linked learning slice in V2. The goal is to turn explicit source material into a normalized Learning Pack with visible Source Provenance, without writing Knowledge Library notes yet.

## Settled Decisions

- Canonical workflow term: **Learning Workflow**.
- Canonical output term: **Learning Pack**.
- Canonical source identity term: **Source Provenance**.
- `forge learn` is a new top-level Workflow, not a Writing Workflow variant.
- The first slice is source-backed only. It requires at least one `--context` attachment or `--with-browser` snapshot.
- The first slice supports multiple sources, including repeated `--context` plus `--with-browser`.
- Learning output language follows the user's task language, not necessarily the source language.
- Source-linked means attachment-level Source Provenance, not sentence-level or paragraph-level citation.
- The first slice produces terminal Session output and Trace evidence only. It does not create `.forgelet/knowledge/` notes.
- `forge notes create --scope project --from-session <sessionId>` and notes search are second-slice work.
- Learning can load Durable Memory for user preference, project terminology, and learning style, but Durable Memory is not source material and must not appear in Source Links.
- `--preview` is supported and must not call a model or create a Session or Trace.
- `--act`, `--allow-read`, and Learning Workflow resume are not available in the first slice.
- No new `learning_pack` Trace event is needed in the first slice. The normalized Learning Pack lives in `final_summary.summary`, and source metadata remains in `context_attachment` events.
- No ADR is needed for this reversible first slice. Revisit ADR coverage only if Forgelet adds persistent learning indexes, a Knowledge Library write path, or a harder-to-reverse citation model.

## CLI Contract

Supported commands:

```bash
forge learn --context paper.md "teach me the core ideas"
forge learn --with-browser "turn this article into study notes"
forge learn --context notes.md --with-browser "compare these two sources"
forge learn --preview --context paper.md "teach me the core ideas"
```

Rejected commands:

```bash
forge learn "teach me the core ideas"
forge learn --act --context paper.md "teach me"
forge learn --allow-read docs --context paper.md "teach me"
forge resume <learning-session-id> "expand the open questions"
```

Expected errors:

- Missing source: make clear that `forge learn` requires `--context` or `--with-browser`.
- `--act`: reuse the coding-only action boundary.
- `--allow-read`: reject for learning because the workflow has no workspace-read capability.
- Learning resume: `Learning Workflow resume is not available yet.`

The first slice reuses existing text Context Attachment file types: `.md`, `.txt`, `.log`, and `.json`. Do not add PDF, HTML, document parsing, or web fetching.

## Learning Pack Contract

Normalize final output to exactly these headings:

```md
## Summary
## Key Concepts
## Source Links
## Open Questions
## Review Prompts
```

Normalization rules:

- If the model returns all five headings, preserve the content while normalizing heading shape as little as practical.
- If the model misses a heading, add the missing heading with a conservative placeholder.
- If the model returns unstructured prose, put it under `Summary`.
- `Source Links` should be filled deterministically from loaded Context Attachments and browser snapshots, not trusted solely to model prose.

`Source Links` should list source identity at attachment level:

- file or browser source
- title when available
- URI or workspace-relative path when available
- content hash
- content bytes
- browser capture metadata when available

Do not promise sentence-level citations or paragraph-level evidence in this slice.

## Capability and Routing Contract

Workflow kind:

```ts
type WorkflowKind = "coding" | "writing" | "learning";
```

Capabilities:

- `read_context`
- `update_plan`
- `model_generate_text`

Not granted:

- `read_workspace`
- `write_workspace`
- `run_safe_command`
- `git_read`

Routing:

- Add `routing.learning` to config.
- Default `routing.learning.default` and `routing.learning.review` to the same current low-cost model as writing.
- Keep model default config non-user-writable in V2 first slice.
- Preserve `--model` as a per-run override.

## Prompt Contract

The Learning Workflow system prompt should say:

- This is a source-backed Learning Workflow Session.
- Use explicit Context Attachments, browser context, and accepted Durable Memory only within their boundaries.
- Treat Durable Memory as preference or terminology guidance, not source material.
- Produce a Learning Pack with the five required headings.
- Prefer the user's requested output language.
- If sources conflict, name the conflict in `Open Questions` or the relevant section.
- Do not request workspace, git, shell, patch, command, note-writing, or browser automation tools.

The user message can reuse existing Context Attachment rendering. No special browser prompt budget is needed.

## Trace and Review Contract

Expected Trace sequence:

```text
session_started(workflow=learning)
user_task
context_attachment...
memory_loaded?             # if accepted Durable Memory exists
routing_selected
plan_update
model_turn...
final_summary              # includes normalized Learning Pack
session_finished
```

Trace rules:

- Context Attachment events keep metadata, hash, size, and preview.
- Trace must not persist full source text beyond existing attachment preview behavior.
- Do not add `learning_pack` in the first slice.
- `forge explain <sessionId>` should work through existing final summary and context attachment evidence.

## Implementation Slices

### Slice 1: Parser and Preview

Update `src/types.ts`, `src/cli/parseArgs.ts`, and CLI preview formatting.

Acceptance:

- `forge learn --context paper.md "teach me"` parses as `workflow: "learning"`.
- `forge learn --with-browser "study this"` parses as learning with browser context.
- Missing source is rejected before model execution.
- `--act` is rejected for learning.
- `--allow-read` is rejected for learning.
- `--preview` prints workflow, route, budget, action mode, context attachments, browser source if present, and capabilities without creating a Session or Trace.

Suggested tests:

- Extend `tests/cli/parseArgs.test.ts`.
- Extend `tests/cli/cliIntegration.test.ts` for preview and error behavior.

### Slice 2: Workflow Type, Capabilities, and Routing

Extend `WorkflowKind`, config routing, route selection, capability grants, and any exhaustive workflow handling.

Acceptance:

- Learning routes through `routing.learning`.
- Learning exposes only `read_context`, `update_plan`, and `model_generate_text`.
- Learning does not expose workspace, git, patch, command, or actionable tools.
- Existing coding and writing behavior remains unchanged.

Suggested tests:

- Add a Learning Workflow tool-schema test in `tests/agent/readOnlySessionLoop.test.ts`.
- Add config route tests in `tests/config/config.test.ts`.

### Slice 3: Learning Prompt and Normalization

Add Learning Workflow prompt guidance and Learning Pack normalization.

Acceptance:

- Model output with all five headings is accepted.
- Missing headings are filled.
- Unstructured output becomes `Summary` plus conservative placeholders.
- `Source Links` is deterministically rendered from loaded source metadata.
- Durable Memory can appear in the prompt but must not appear as a Source Link.

Suggested tests:

- Add Learning Workflow prompt assertions in `tests/agent/readOnlySessionLoop.test.ts`.
- Add normalization tests covering structured, partially structured, and unstructured model output.
- Add a test proving Source Links are present even if the model omits them.

### Slice 4: Model-Backed Learning Runs

Wire the Learning Workflow through `runAgent` and `runWorkflowSession`.

Acceptance:

- `forge learn --context paper.md "teach me the core ideas"` creates a model-backed Session and prints a normalized Learning Pack.
- `forge learn --with-browser "turn this article into study notes"` consumes the current browser snapshot.
- Multiple sources appear in prompt input and Source Links.
- Trace includes `workflow: "learning"`, context attachment metadata, final summary, and session finish.
- No Knowledge Library files are written.

Suggested tests:

- Add CLI integration tests with fake model output.
- Add browser-context learning test based on existing browser context tests.
- Add a negative assertion that `.forgelet/knowledge/` is not created.

### Slice 5: Explain and Resume Boundaries

Ensure review surfaces and unsupported continuation behavior are clear.

Acceptance:

- `forge sessions show <learning-session-id>` and `forge explain <learning-session-id>` show normal Session evidence.
- `forge resume <learning-session-id> "..."` rejects with `Learning Workflow resume is not available yet.`
- Coding resume remains unchanged.
- Writing resume rejection remains unchanged.

Suggested tests:

- Extend CLI integration tests for Learning Workflow explain/show basics.
- Add resume rejection coverage for learning traces.

## Second-Slice Notes Workflow

Do not implement this in the first slice, but leave the path clear for:

```bash
forge notes create --scope project --from-session <sessionId>
forge notes search --scope project "workflow graph design"
```

Open decisions for the notes slice:

- Knowledge Note file naming and frontmatter.
- Whether `notes create` allows editing before save.
- How to select content from a Learning Session.
- Whether `--scope personal` is accepted, rejected, or reserved.
- How much Source Provenance to preserve in the Markdown note.
- Whether note search is plain-text first or introduces a rebuildable index.

## Non-Goals

- No Knowledge Library writes.
- No notes create/search commands.
- No sentence-level citation model.
- No PDF, HTML, document, or web parsing.
- No workspace exploration.
- No shell commands.
- No browser automation.
- No Learning Workflow resume.
- No new Trace event type for Learning Pack.
- No durable memory writes or memory suggestions specific to learning in this slice.

## Validation

Suggested command ladder:

```bash
npm test -- tests/cli/parseArgs.test.ts
npm test -- tests/cli/cliIntegration.test.ts
npm test -- tests/agent/readOnlySessionLoop.test.ts
npm run typecheck
```

If targeted Jest arguments are awkward in the current runner, run `npm test` and `npm run typecheck`.

## Done Definition

- `forge learn` is a top-level, source-backed Learning Workflow.
- It supports text Context Attachments and browser snapshots.
- It rejects no-source, `--act`, `--allow-read`, and resume in the first slice.
- It exposes only learning-safe capabilities.
- It uses independent learning routing with the current low-cost default model.
- It returns a normalized Learning Pack with deterministic Source Links.
- Trace records source metadata through existing context attachment events and final output through final summary.
- README and CLI help document the first learning commands and clarify that Knowledge Library writes are a later explicit notes workflow.
