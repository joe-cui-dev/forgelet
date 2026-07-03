# Knowledge Notes Execution Plan

Implement `forge notes create/search` as the first explicit Knowledge Library slice after the Learning Workflow. The goal is to let a user promote a completed, source-backed Learning Pack into a project Knowledge Note and search accepted project notes without introducing hidden memory, vector indexes, or model-driven note writing.

## Settled Decisions

- Canonical library term: **Knowledge Library**.
- Canonical note term: **Knowledge Note**.
- `forge notes create` is a promotion command, not a general notes app entrypoint.
- The first slice only promotes completed **Learning Workflow** Sessions.
- `forge notes create` deterministically promotes the normalized Learning Pack from `final_summary.summary`; it does not call a model.
- The explicit `notes create` command is the user's approval to write the Knowledge Note. Do not add a second interactive confirmation in the first slice.
- The first slice supports only `--scope project`. Preserve the command shape for future personal scope, but reject `--scope personal` with a clear "not available yet" error.
- Project Knowledge Notes are Markdown files under `.forgelet/knowledge/`.
- A Knowledge Note path is deterministic: `.forgelet/knowledge/<task-slug>-<sessionId>.md`.
- Re-running `notes create` for the same Session should not overwrite or duplicate the note. If the target path already exists, fail and report the existing path.
- A Knowledge Note uses YAML frontmatter plus the normalized Learning Pack body.
- `forge notes search` is local Markdown full-text search over accepted project Knowledge Notes. It does not use embeddings, vector search, or a persistent index.
- `notes create/search` do not create a new Session or Trace and do not mutate the source Session Trace.
- Do not expose notes write/search as Workflow tools or Capabilities in this slice.
- No new ADR is needed. ADR 0008 already records the Markdown source-of-truth decision; this first slice is reversible implementation scope.

## CLI Contract

Supported commands:

```bash
forge notes create --scope project --from-session <sessionId>
forge notes create --scope project --from-session <sessionId> --title "Custom title"
forge notes search --scope project "workflow graph design"
forge notes search --scope project --limit 5 "workflow graph design"
```

Rejected commands:

```bash
forge notes create --scope personal --from-session <sessionId>
forge notes create --from-session <sessionId>
forge notes create --scope project
forge notes create --scope project --from-session <non-learning-session-id>
forge notes create --scope project --from-session <failed-or-stopped-learning-session-id>
forge notes search --scope personal "workflow graph design"
forge notes search "workflow graph design"
forge notes search --scope project --json "workflow graph design"
```

Expected errors:

- Missing or unsupported scope: make clear that the first slice requires `--scope project`.
- Personal scope: `Personal Knowledge Scope is not available yet.`
- Missing `--from-session`: show `forge notes create --scope project --from-session <sessionId> [--title <title>]`.
- Ineligible source Session: make clear that Knowledge Note creation requires a completed, source-backed Learning Session with a final summary.
- Existing target note: report the existing path and do not overwrite it.
- Missing query: show `forge notes search --scope project [--limit <n>] "<query>"`.
- Unsupported `--json`: make clear that JSON output is not available yet.

## Create Contract

Eligibility:

- The source Session trace must exist and be readable.
- The source Session must have `session_started.payload.workflow === "learning"`.
- The source Session must have `session_finished.payload.status === "completed"`.
- The source Session must have a `final_summary.payload.summary`.
- The source Session must have at least one `context_attachment` event.

Content source:

- Use `final_summary.payload.summary` as the Knowledge Note body source.
- Do not regenerate, polish, summarize, or restructure the body with a model.
- Preserve the normalized Learning Pack headings exactly as already produced by the Learning Workflow.
- If the final summary already starts with a Markdown H1, avoid adding a duplicate H1. Otherwise add a single title H1 before the Learning Pack body.

Title:

- Default title is derived from the source Session task.
- `--title <title>` overrides the Markdown H1 and frontmatter `title`.
- The override does not change `sourceSessionId`, source metadata, or the target path in the first slice.

Path:

```text
.forgelet/knowledge/<task-slug>-<sessionId>.md
```

Path rules:

- Use the same slug style as Writing Artifact filenames where practical.
- Include the source Session id in the file name.
- Create `.forgelet/knowledge/` when needed.
- Use an exclusive write or existence check so existing notes are never overwritten.
- Return a workspace-relative path in CLI output.

## Knowledge Note File Shape

Use YAML frontmatter followed by human-readable Markdown:

```md
---
type: knowledge-note
scope: project
title: Teach Me The Core Ideas
sourceSessionId: sess_abc123
sourceWorkflow: learning
createdAt: 2026-07-03T00:00:00.000Z
contentHash: abcdef...
sources:
  - source: file
    title: paper.md
    uri: paper.md
    contentHash: 123456...
    contentBytes: 2048
---

# Teach Me The Core Ideas

## Summary
...

## Key Concepts
...

## Source Links
...

## Open Questions
...

## Review Prompts
...
```

Frontmatter rules:

- Keep frontmatter limited to provenance and classification metadata.
- `contentHash` should hash the Markdown body after frontmatter, so the note body remains inspectable and verifiable.
- `sources` should be derived from `context_attachment` events, not model prose.
- Use only metadata already present in Trace events: source, title, uri, contentHash, contentBytes, trustLevel when present.
- Do not persist full source text in frontmatter.

## Search Contract

Search scope:

- First slice searches only `.forgelet/knowledge/**/*.md` for `--scope project`.
- No personal scope.
- No vector search.
- No persistent index.
- No model calls.
- No JSON output.

Matching:

- Case-insensitive substring matching is sufficient for the first slice.
- Search both frontmatter and body so `sourceSessionId`, title, source URI, and note text are discoverable.
- Ignore non-Markdown files.

Result ordering:

- Prefer frontmatter `createdAt` descending when available.
- Fall back to file modification time descending.
- Apply `--limit <n>` after sorting. Default limit: 10.

Human-readable output:

```text
Knowledge Notes Search
Scope: project
Path: .forgelet/knowledge
Query: workflow graph design
Results: 2

1. Workflow Graph Design
   Path: .forgelet/knowledge/teach-me-the-core-ideas-sess_abc123.md
   Source Session: sess_abc123
   Snippet: ...workflow graph design...
```

No-result output should include scope, searched path, query, and `Results: 0`.

## Capability and Trace Boundaries

`forge notes create/search` are CLI-level Knowledge Library management commands:

- They are not Workflows.
- They do not create Sessions.
- They do not write Trace files.
- They do not append events to the source Session Trace.
- They do not receive Workflow Capability Grants.
- They do not expose `notes_write`, `notes_search`, or `knowledge_query` tools to any Workflow.

Keep the Learning Workflow system prompt boundary intact: Learning can produce a Learning Pack, but it cannot write Knowledge Library notes during the Session.

## Implementation Slices

### Slice 1: Parser and CLI Dispatch

Add a `notes` command family to `src/cli/parseArgs.ts` and dispatch it from `src/cli/index.ts`.

Acceptance:

- `forge notes create --scope project --from-session sess_123` parses.
- `forge notes create --scope project --from-session sess_123 --title "Custom title"` parses.
- `forge notes search --scope project "query"` parses.
- `forge notes search --scope project --limit 5 "query"` parses.
- Personal scope, missing scope, missing source Session, missing query, invalid limit, and unsupported `--json` are rejected clearly.

Suggested tests:

- Extend `tests/cli/parseArgs.test.ts`.
- Add CLI integration tests for top-level error strings.

### Slice 2: Knowledge Note Creation Module

Add a small Knowledge Library module, for example `src/knowledge/index.ts`, that reads source Session traces and writes Knowledge Notes.

Acceptance:

- Completed Learning Session with `final_summary` and `context_attachment` creates one Markdown file under `.forgelet/knowledge/`.
- Writing, coding, failed, stopped, incomplete, missing-final-summary, and source-less Learning Sessions are rejected.
- Target path includes task slug and source Session id.
- Existing target path is not overwritten.
- CLI output includes note path, source Session id, source count, and content hash.

Suggested tests:

- Add focused unit tests for eligibility and Markdown rendering.
- Add CLI integration tests that create a fake Learning trace and run `notes create`.
- Add negative tests for ineligible source Sessions.

### Slice 3: Frontmatter and Provenance

Render stable YAML frontmatter and preserve source provenance from Trace metadata.

Acceptance:

- Frontmatter includes `type`, `scope`, `title`, `sourceSessionId`, `sourceWorkflow`, `createdAt`, `contentHash`, and `sources`.
- `sources` uses `context_attachment` metadata.
- No full source text is copied into frontmatter.
- The body contains the normalized Learning Pack and a single H1 title.

Suggested tests:

- Assert frontmatter fields from a fake trace.
- Assert no duplicate H1 when the Learning Pack already starts with one.
- Assert body hash changes when body content changes.

### Slice 4: Markdown Search

Implement project-scope full-text search over `.forgelet/knowledge/**/*.md`.

Acceptance:

- Search finds matches in body text.
- Search finds matches in frontmatter metadata such as `sourceSessionId` or source URI.
- Search is case-insensitive.
- Results include title, path, source Session id, and a short snippet.
- Default limit is 10.
- `--limit` changes the maximum result count.
- No-result output is explicit and non-error.
- Missing `.forgelet/knowledge/` returns no results rather than failing.

Suggested tests:

- Add unit tests for search matching and snippet generation.
- Add CLI integration tests for result output, limit, and no-result behavior.

### Slice 5: Docs and Help

Update README, CLI help, and the V2 roadmap references.

Acceptance:

- README documents `forge notes create/search` after Learning Workflow.
- CLI help includes notes commands and clarifies project-scope-only first slice.
- The roadmap links this execution plan from the post-learning notes slice.
- Existing language still says Learning itself does not write Knowledge Library notes.

## Non-Goals

- No free-form note creation.
- No Writing or Coding Session promotion.
- No stopped, failed, incomplete, or source-less Session promotion.
- No model polishing or note rewriting.
- No interactive editor.
- No second approval prompt.
- No personal Knowledge Scope implementation.
- No Knowledge Library write tools inside Workflows.
- No Session or Trace for notes management commands.
- No mutation of source Session Traces.
- No vector search, embeddings, or persistent index.
- No JSON output.
- No tags, folders, backlinks, or delete/edit commands.

## Validation

Suggested command ladder:

```bash
npm test -- tests/cli/parseArgs.test.ts
npm test -- tests/cli/cliIntegration.test.ts
npm test -- tests/knowledge/knowledgeNotes.test.ts
npm run typecheck
```

If targeted Jest arguments are awkward in the current runner, run `npm test` and `npm run typecheck`.

Manual smoke path:

```bash
forge learn --context fixtures/learning/article.md "teach me the core ideas"
forge notes create --scope project --from-session <learning-session-id>
forge notes search --scope project "core ideas"
```

Then inspect:

```text
.forgelet/knowledge/<task-slug>-<sessionId>.md
```

## Done Definition

- `forge notes create --scope project --from-session <sessionId>` promotes a completed, source-backed Learning Session into one Markdown Knowledge Note.
- The Knowledge Note path, frontmatter, body, and source provenance are deterministic and inspectable.
- Repeated creation does not overwrite or duplicate an existing note.
- `forge notes search --scope project [--limit <n>] "<query>"` searches accepted project Knowledge Notes with human-readable output.
- Learning Workflow behavior remains unchanged: learning Sessions do not write Knowledge Library notes on their own.
- No notes management command creates or mutates Sessions or Traces.
- Tests cover parser, eligibility, rendering, duplicate protection, search, and CLI output.
