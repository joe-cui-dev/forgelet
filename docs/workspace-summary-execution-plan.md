# Workspace Summary Execution Plan

Implement `workspace_summary` as a deterministic, on-demand read tool that helps a Coding Session understand the current workspace shape before falling into broad file-by-file exploration.

## Settled Decisions

- Canonical term: **Workspace Summary**.
- First slice is on-demand static analysis, not a persisted cache, durable memory, Knowledge Library note, embedding index, or automatic Session injection.
- The tool belongs to the existing `workspace` Tool Provider and requires only `read_workspace`.
- The tool must obey **Session Read Scope**. Inputs can narrow the readable area or reduce output size, but must never expand access.
- The tool does not read Git tracked-file state, status, or diffs. Current-change evidence remains with `git_status` and `git_diff`.
- Tool output uses the existing observation shape: `data.content` is compact Markdown for the model, with additional structured fields for tests, `forge explain`, and future UI surfaces.
- No ADR is needed for this first reversible tool slice. Revisit ADR coverage only if Forgelet adds persistent indexing, cache invalidation, embedding-backed retrieval, or default automatic injection.

## Tool Contract

Name: `workspace_summary`

Provider and capability:

- `providerId: "workspace"`
- `capability: "read_workspace"`

Input schema:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "maxFiles": { "type": "number" },
    "maxExcerptBytes": { "type": "number" }
  },
  "additionalProperties": false
}
```

Input rules:

- `path` is optional and defaults to `"."`.
- `path` narrows the summary root and must overlap the Session Read Scope.
- `maxFiles` and `maxExcerptBytes` are optional positive integers.
- Do not add glob patterns, include/exclude rules, section toggles, or depth controls in the first slice.

Output expectations:

- `data.content`: compact Markdown summary for model consumption.
- Structured fields should include at least:
  - `path`
  - `scopeConstrained`
  - `limits`
  - `directories`
  - `manifests`
  - `configs`
  - `scripts`
  - `dependencies`
  - `entrypointCandidates`
  - `testConventions`
  - `excerpts`
  - `skippedDirectories`
  - `truncated`

Markdown sections should stay concise and evidence-shaped:

- Workspace
- Scripts and dependencies
- Directory shape
- Entrypoint candidates
- Tests
- High-signal excerpts
- Limits

The Limits section should appear when relevant and name the effective path, whether Session Read Scope constrained the result, active budgets, skipped generated/internal directories, and truncated excerpts. Do not produce a full candidate-by-candidate audit log.

## Implementation Slices

### Slice 1: Tool Schema and Registration

Add the tool to `createReadOnlyTools` in `src/tools/readOnly.ts`, but keep implementation logic in `src/tools/workspaceSummary.ts`.

Acceptance:

- Coding Sessions expose `workspace_summary` alongside existing read-only tools.
- Writing Sessions do not receive it, because they do not receive `read_workspace`.
- ToolRegistry projection still hides `providerId`, `capability`, and `execute` from model-facing schemas.

Suggested tests:

- Extend `tests/agent/readOnlySessionLoop.test.ts` tool schema expectations.
- Add a direct registry or read-only tool test if existing assertions become too broad.

### Slice 2: Static Workspace Scan

Create `src/tools/workspaceSummary.ts` with scan and render functions that can be unit tested without model execution.

The scanner should:

- Reuse the existing workspace path safety and Session Read Scope behavior, or extract shared helpers from `src/tools/readOnly.ts` if needed.
- Skip generated/internal folders such as `.git`, `.forgelet`, `node_modules`, `dist`, and `dist-test`.
- Detect manifest/config candidates such as `package.json`, `tsconfig*.json`, lockfiles, build/test config files, and README files.
- Summarize source, test, fixture, and docs directory shape.
- Identify likely entrypoint candidates such as `src/cli/index.ts`, `src/index.ts`, `src/main.ts`, or package `bin`/`main` fields when present.
- Detect test conventions from filenames and directories.

Acceptance:

- The same workspace produces deterministic output ordering.
- A narrow Session Read Scope limits both scanned files and directory shape.
- A `path` input narrows the effective summary area but cannot escape or expand Session Read Scope.
- Non-Git workspaces still produce useful summaries.

Suggested tests:

- Add focused unit tests under `tests/tools/workspaceSummary.test.ts`.
- Include fixtures for package scripts/config discovery, entrypoint detection, tests, read-scope narrowing, and generated-directory skipping.

### Slice 3: High-Signal Excerpts and Budgets

Add bounded excerpts for a small number of high-signal files.

Candidate excerpt priority:

1. README or context-like docs near the effective root.
2. `package.json` or equivalent manifest.
3. TypeScript or build config.
4. Likely CLI/app entrypoint.
5. A representative test file when useful.

Budget rules:

- `maxFiles` caps scanned or rendered file candidates.
- `maxExcerptBytes` caps each excerpt.
- Excerpts must report truncation.
- Binary or obviously non-text files are skipped.

Acceptance:

- Markdown remains compact under defaults.
- Structured `excerpts` include path, returned bytes, total bytes when known, and truncation state.
- Truncated excerpts are visible in both structured data and the Markdown Limits section.

### Slice 4: Prompt Guidance

Update the Coding Workflow system prompt in `src/workflows/index.ts`.

Prompt intent:

- Tell the model to call `workspace_summary` first when it needs an overview of an unfamiliar workspace.
- Tell it to follow up with targeted `search_text`, `read_file`, `git_status`, or `git_diff` only when specific evidence is needed.
- Do not imply the summary is automatically injected.

Acceptance:

- Read-only and actionable Coding Sessions both receive the guidance.
- Writing Workflow prompts still forbid workspace/git/shell tools.
- Tests assert the prompt mentions `workspace_summary` for Coding Workflow and does not leak into Writing Workflow.

### Slice 5: Trace, Explain, and Validation

The existing tool observation path should work because `toolResultToObservation` already reads `data.content` and metadata-like fields.

Acceptance:

- Trace stores a compact preview, not full unlimited excerpts.
- `forge explain` can show the tool result summary like other tool calls.
- The model-visible observation contains Markdown content.
- Structured data is available in tests before observation conversion.

Suggested validation:

```bash
npm test -- tests/tools/workspaceSummary.test.ts
npm test -- tests/agent/readOnlySessionLoop.test.ts
npm run typecheck
```

If the repo test runner does not support file arguments consistently, run the nearest existing targeted test command first, then full `npm test` if the slice touches shared tool behavior.

## Non-Goals

- No persistent workspace index.
- No cache invalidation policy.
- No vector database or embedding retrieval.
- No Git status/diff/tracked-file integration.
- No automatic default injection of the summary body into every Coding Session.
- No broad query language, glob matching, section toggles, or custom include/exclude rules.

## Done Definition

- `workspace_summary` is available to Coding Sessions through the read-only tool set.
- It respects Session Read Scope and workspace path safety.
- It returns compact Markdown plus structured data.
- It reports meaningful limits and truncation.
- Coding prompt guidance encourages summary-first exploration for unfamiliar workspaces.
- Focused tests and typecheck pass.
