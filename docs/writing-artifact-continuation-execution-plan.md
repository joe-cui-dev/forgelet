# Writing Artifact Continuation Execution Plan

## Source Decisions

- Glossary terms: `Writing Artifact`, `Writing Artifact Continuation`, and updated `Draft Pack` in `CONTEXT.md`.
- Roadmap issue: `FORGELET_LONG_TERM_PLAN_V2_V3.md`, V2 Issue 0a.
- No ADR is needed for the first slice because the decision is reversible and follows the existing Creative Writing Workflow surface.

## Goal

Let a user continue prose from an existing Markdown Writing Artifact through the Creative Writing Workflow:

```bash
forge write --creative --style vivid --continue .forgelet/writing/chapter-1.md "continue the next chapter"
```

The selected artifact is the continuation source. The result is a Draft Pack with one continued draft, saved as a new `.forgelet/writing/` artifact without overwriting the source.

## Non-Goals

- Do not implement a Writing Project, chapter registry, story bible, or persistent long-form project state.
- Do not use `forge resume` or Session Continuation semantics.
- Do not add an interactive artifact picker or artifact listing command.
- Do not add a new `writing_artifact_source` Trace event in the first slice.
- Do not support multiple `--continue` artifacts.

## Behavior Contract

- `forge write --creative --style <name> --continue <artifact.md> "<creative brief>"` routes to `workflow: "writing"` and `workflowVariant: "creative"`.
- `--continue` is valid only with `forge write --creative`.
- Exactly one `--continue` value is allowed.
- `--continue` accepts an explicit Markdown path, including saved artifacts under `.forgelet/writing/` and other explicit workspace or absolute Markdown paths.
- Missing, unreadable, or unsupported continuation paths produce a clear CLI error that points users toward `.forgelet/writing/`.
- `--continue` can be combined with repeated `--context` attachments.
- The continuation source and additional context attachments reuse the existing Context Attachment loading and Trace evidence path.
- The model-facing prompt separates:
  - `Continuation source`
  - `Additional context attachments`
- The internal runner carries a creative input discriminant such as `creativeInputKind: "draft" | "revision" | "continuation"`.
- `creativeInputKind: "continuation"` produces and normalizes a Draft Pack even when attachments are present.
- The saved artifact for continuation output uses `contentKind: "draft"` and writes only the continued Draft body.

## Delivery Slices

### Slice 1: Parser and Types

Add the CLI and internal data shape without changing model behavior yet.

Acceptance criteria:

- `src/types.ts` defines the creative input discriminant.
- `src/cli/parseArgs.ts` parses `--continue <path>` on `forge write --creative`.
- Parser rejects:
  - `--continue` outside the Writing Workflow
  - `--continue` without `--creative`
  - missing `--continue` value
  - repeated `--continue`
  - `--continue` paths with unsupported extensions
- Parser keeps existing `--context`, `--style`, `--model`, and `--budget` behavior unchanged.

Suggested TDD path:

1. Extend `tests/cli/parseArgs.test.ts` for valid `--continue`.
2. Add parser errors for repeated and misplaced `--continue`.
3. Add the minimal type fields needed by `ForgeCommand` and `RunAgentInput`.
4. Thread the field through `runCli(...)` into `runAgent(...)`.

### Slice 2: Context Loading and Prompt Shape

Load the continuation artifact through the existing attachment path while preserving its semantic role.

Acceptance criteria:

- `runWorkflowSession(...)` receives the continuation artifact path separately from ordinary `contextFiles`.
- The continuation artifact is loaded with the same provenance, hash, size, preview, and Trace `context_attachment` evidence as other Markdown attachments.
- Prompt rendering labels the selected artifact as `Continuation source`.
- Ordinary `--context` files appear under `Additional context attachments`.
- If only `--continue` is present, the prompt does not label the source as a revision context.
- If both `--continue` and `--context` are present, the prompt preserves their separate roles.

Suggested TDD path:

1. Add a workflow test in `tests/agent/readOnlySessionLoop.test.ts` proving the first model turn contains `Continuation source`.
2. Add a second workflow test proving additional `--context` files are labeled separately.
3. Keep Trace assertions on existing `context_attachment` events rather than adding a new event type.
4. Refactor `formatContextAttachmentsForPrompt(...)` or add a sibling formatter so the labels are explicit and tests are stable.

### Slice 3: Draft Pack Normalization and Artifact Writing

Make continuation output behave like new prose, not revision.

Acceptance criteria:

- `creativeInputKind: "continuation"` system prompt asks for only a Draft heading followed by continued prose.
- Continuation output is normalized to a Draft Pack when the model omits the heading.
- Continuation output does not include default `Critique`, `Revision`, `Alternatives`, or `Notes`.
- The saved writing artifact extracts the `Draft` section and records `contentKind: "draft"`.
- The source artifact is never overwritten.

Suggested TDD path:

1. Add a workflow test where the fake model returns raw prose and the final summary is normalized to `Draft`.
2. Assert the saved artifact contains only the continued prose.
3. Assert `result.writingArtifact?.contentKind` is `draft`.
4. Assert the original continuation source file remains unchanged.

### Slice 4: CLI Integration and Docs

Expose the complete user path and document it.

Acceptance criteria:

- `tests/cli/cliIntegration.test.ts` proves a live creative continuation run creates a new writing artifact.
- CLI errors for invalid continuation paths mention `.forgelet/writing/`.
- `src/cli/help.ts` includes a `--continue` example.
- `README.md` documents Writing Artifact Continuation with one example.
- `FORGELET_LONG_TERM_PLAN_V2_V3.md` links to this execution plan from V2 Issue 0a.

Suggested TDD path:

1. Add a CLI integration test using a temp `.forgelet/writing/chapter-1.md`.
2. Assert `createLiveModelClient` receives `workflow: "writing"`.
3. Assert stdout includes `Writing artifact: .forgelet/writing/...`.
4. Assert Trace contains `workflowVariant: "creative"` and context attachment evidence for the continuation source.
5. Update help and README last, after behavior is stable.

## Validation

Run the focused tests first:

```bash
npm test -- tests/cli/parseArgs.test.ts tests/agent/readOnlySessionLoop.test.ts tests/cli/cliIntegration.test.ts
```

Then run the full repo gates:

```bash
npm test
npm run typecheck
npm run build
```

## Implementation Notes

- Prefer a small, explicit discriminant over inferring continuation from attachment counts. Existing creative writing with `--context` must keep producing a Revision Pack.
- Keep `ContextAttachment` as the evidence mechanism in the first slice. A future `writing_artifact_source` Trace event should wait until sessions/read models need a richer distinction.
- Keep this feature text-first and tool-isolated. Creative writing should not gain workspace, git, shell, patch, or command tools through continuation.
- Treat `.forgelet/writing/` as a convenient default location, not as the only legal source path.
