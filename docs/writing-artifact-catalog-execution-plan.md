# Writing Artifact Catalog Execution Plan

Implement `forge write artifacts list/show` as a project-local catalog for saved Writing Artifacts. The goal is to help users find and reuse outputs from the Writing Workflow without introducing a new content store, Artifact ids, or long-form Writing Project continuity.

## Decisions

- Canonical term: **Writing Artifact Catalog**.
- The Catalog is project-local and derived. It does not own prose, mutate artifacts, or inspect arbitrary Markdown files.
- The Catalog is Trace-first with filesystem reconciliation.
- Catalog commands are deterministic reads. They do not create Sessions, write Traces, call a model, update memory, or create Knowledge Notes.
- MVP command shape:

```bash
forge write artifacts list
forge write artifacts show <artifact>
forge write artifacts show <artifact> --full
```

## Inputs

- Trace files under `.forgelet/sessions/*.jsonl`.
- Writing Artifact files under `.forgelet/writing/*.md`.
- The `writing_artifact` Trace event payload, plus related Session metadata such as `session_started`, `routing_selected`, and `final_summary` when present.

## Catalog Model

Represent each entry with:

- `path`: workspace-relative Writing Artifact path.
- `status`: `available`, `missing`, or `untracked`.
- `contentKind`: `draft`, `revision`, `final`, or `unknown`.
- `contentBytes`: bytes from Trace metadata or current file stat.
- `sessionId`: producing Session id when known.
- `createdAt`: preferably the `writing_artifact` event timestamp; otherwise file mtime for untracked files.
- `task`: Session task when known.
- `workflowVariant`: usually `creative` when known.
- `creativeStyle`: style when known.
- `tracePath`: workspace-relative Trace path when known.

Ordering: newest first by `createdAt`.

## CLI Behavior

### `forge write artifacts list`

Print a human-readable catalog:

```text
Writing Artifact Catalog
Path: .forgelet/writing
Artifacts: 3
Untracked: 1

1. write-rain-scene-sess_abc.md
   Status: available
   Kind: draft
   Session: sess_abc
   Created: 2026-07-04T10:22:00.000Z
   Task: write a rain-soaked convenience store scene
   Bytes: 4210
   Continue: forge write --creative --style vivid --continue .forgelet/writing/write-rain-scene-sess_abc.md "<brief>"
```

Rules:

- Exit `0` when the catalog is empty, missing, or contains degraded entries.
- Include untracked `.forgelet/writing/*.md` files by default and mark them `Status: untracked`.
- Mark Trace-backed entries whose file no longer exists as `Status: missing`.
- Render a best-effort `Continue:` hint:
  - For `available` or `untracked` entries with a known creative style, use the concrete style.
  - For `available` or `untracked` entries without a known creative style, use `--style <style>` rather than guessing.
  - For `missing` entries, render `Continue: unavailable; artifact file is missing`.
- Do not support search, filters, limit, sort flags, JSON, delete, rename, or interactive picking in the first slice.

### `forge write artifacts show <artifact>`

Accept:

- A project Writing Artifact path under `.forgelet/writing/`.
- A producing Session id such as `sess_abc`.

Reject:

- Workspace-external paths.
- Workspace-local Markdown files outside `.forgelet/writing/`.
- Unknown Session ids or Sessions without a Writing Artifact.

Default output is metadata plus a bounded preview:

```text
Writing Artifact
Path: .forgelet/writing/write-rain-scene-sess_abc.md
Status: available
Kind: draft
Session: sess_abc
Created: 2026-07-04T10:22:00.000Z
Task: write a rain-soaked convenience store scene
Bytes: 4210
Trace: .forgelet/sessions/sess_abc.jsonl
Continue: forge write --creative --style vivid --continue .forgelet/writing/write-rain-scene-sess_abc.md "<brief>"

Preview:
...
```

Rules:

- Default preview reads the first 4000 characters and appends `[truncated]` when the file is longer.
- `--full` prints the complete artifact body after the metadata.
- `show <missing-session-id>` exits `1` because the requested body cannot be shown, but the error should mention that Trace provenance still exists.
- `show <untracked-path>` exits `0` when the path is under `.forgelet/writing/`, shows the preview, and reports provenance as `none`.
- `Continue:` uses the same best-effort format as `list`.

## Implementation Slices

1. Parser and command type support for `forge write artifacts list`, `forge write artifacts show <artifact>`, and `--full`.
2. Add `src/writingArtifacts/index.ts` with a structured Catalog reader that scans Trace files, extracts `writing_artifact` provenance, reconciles `.forgelet/writing/*.md`, reads preview/full artifact content, and returns sorted entries.
3. CLI formatting for `list` and `show`, including preview/full behavior and continue-command hints.
4. User-facing help and README updates after tests are green.

## Test Coverage

- Parser tests for accepted and rejected command shapes.
- Catalog reader tests for available, missing, and untracked entries.
- CLI integration tests for list output, show by path, show by Session id, `--full`, missing artifacts, untracked artifacts, and external path rejection.
- Regression assertion that Catalog commands do not create Session Trace files or call the model factory.

## Out of Scope

- Artifact ids.
- Writing Project model, chapter registry, story bible, or project continuity.
- Search, filters, JSON, sort, limit, delete, rename, or interactive selection.
- Personal/global writing artifact scope.
- Arbitrary Markdown preview outside project Writing Artifacts.
