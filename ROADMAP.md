# Forgelet Roadmap

Forgelet is a local-first personal Agent Kernel with a CLI-first surface. V1 is dogfoodable: Coding Sessions can inspect, edit with approval, verify, and explain changes; Writing and Learning workflows can produce saved artifacts and source-linked outputs.

## Current Product Shape

Forgelet should remain a workbench for code, writing, learning, browser context, knowledge notes, and durable memory. It should not become a hidden autonomous assistant. Durable writes, command execution, memory persistence, and external effects require explicit boundaries and trace evidence.

Current implemented surfaces:

- `forge code` for read-only and actionable Coding Sessions.
- `forge write` for prose revision, creative drafting, browser-backed writing, saved Writing Artifacts, artifact continuation, Writing Project continuity, and artifact catalog search.
- `forge learn` for source-backed Learning Packs from files or browser context.
- `forge notes create/search` for project-scope Knowledge Notes promoted from completed Learning Sessions.
- `forge browser read-current` and `forge browser install-host` for read-only browser snapshots.
- `forge resume` for child Session Continuations.
- `forge sessions`, `forge explain`, `forge memory suggest/accept`, and config commands for review and operation.

## Long-Term Direction

Forgelet's destination is a bounded autonomous agent: it acts on the user's behalf under declared authority, never hidden, always evidenced. Autonomy grows along a declared ladder, and every rung reuses the same kernel boundaries — Capabilities, Permission Policy, Effect Envelope, budget, and Trace — rather than inventing parallel trust mechanisms.

1. Background Sessions (first rung):
   The user starts a long task interactively, declares an Effect Envelope — write scope, command allowlist, budget — and leaves. The Session continues unattended, auto-approving confirmable actions inside the envelope with Trace evidence, and pauses in place as the same Session when it needs anything outside it (ADR 0026, ADR 0027). Paused and finished Sessions surface in a CLI Decision Queue; deciding from the queue resumes the Session. The CLI remains the decision surface; the Local Review UI stays sequenced per ADR 0009, with its long-term job re-framed as the richer review surface for background outcomes.

2. Memory depth before frequency:
   Unattended runs replace interactive steering with remembered guidance, so memory quality gates the ladder. Durable Memory gains a personal Memory Scope alongside project scope, and whole-file injection is replaced by bounded Memory Recall recorded as Trace evidence. Writes stay user-approved per ADR 0007; memory suggestions produced by background Sessions land in the Decision Queue.

3. Scheduled Routines paired with read-only external sources:
   Recurring user-declared Sessions — nightly repo digests, learning review packs — reuse the Effect Envelope and the Decision Queue; the scheduler is the only new part. They advance together with read-only external Tool Providers (issue trackers, docs, feeds) whose output enters Sessions as Context Attachments, following the Browser Context Bridge precedent, because routine runs without fresh external input produce mediocre output.

Far-future and not committed: event-triggered Sessions, proactive suggestions, and mutating external Capabilities. The gate for external mutation is Effect Envelope semantics proven for external effects. What stays banned is concealment, not autonomy: every Session start must trace to an explicit user action or a user-declared schedule.

## Next Candidate Slices

1. Expanded creative Style Presets:
   Keep the public `--style` CLI option while replacing the current one-word creative style labels with 12 effect-focused Style Preset keys: `plain`, `vivid`, `tight`, `literary`, `cinematic`, `minimal`, `lyrical`, `noir`, `warm`, `sharp`, `sensual`, and `ardent`. Load full preset definitions from ignored project-local `.forgelet/style-presets.local.json`, using a source-controlled public fallback only when the local file is missing. Local definitions use labels, aims, instructions, avoid rules, and revision focus so prompts become stable and testable. `tight` means tense atmosphere, not compact prose. Creative workflow prompts should consume the selected definition as a distinct Style Preset block. Sessions and Traces should continue recording only the selected preset key, not the full preset definition. Do not add `forge write styles list/show` in this slice; document discovery through README, help text, and validation errors.
   Accept the slice when parser tests cover all 12 presets and unknown-style errors, registry tests prove local definitions validate correctly, workflow tests prove draft, continuation, and revision prompts include the Style Preset block, Session/Trace assertions still record only the preset key, and README/help text list the available presets. Do not add automated prose quality scoring.

2. CLI decomposition by responsibility:
   Split `src/cli/index.ts` into presentation, wiring, and dispatch across three behavior-preserving slices. First move the formatter functions into `src/cli/present/` grouped by domain and extract the `run` command body into its own module, keeping per-workflow typed session entry points per ADR 0025. Second, extract model-client and approval-handler assembly into `src/cli/wiring.ts`, and sink the provider-for-model mapping and model runnability checks into `src/models/routing.ts` so adding a provider never edits CLI files. Third, sink `prepareWritingProjectRun` and `resolveProjectContinuationFile` into `src/writingProjects` so Project Manifest and Continuation Head rules live with the domain and later surfaces such as the local review UI cannot bypass them. This split is also the precursor to Background Sessions: once wiring leaves the CLI, a Session stops assuming an interactive terminal.
   Accept each slice when all existing tests pass unchanged and `runCli` stdout/stderr shapes and error messages stay identical; accept the final slice when `src/cli/index.ts` contains only command dispatch.

3. Project memory review workflow:
   Turn memory suggestions into a clearer review surface while keeping writes user-approved and traceable. This is the precursor to Memory Scope and Memory Recall work on the long-term ladder.

4. Background Session MVP:
   Run one user-initiated Coding or Writing Session to completion without the user present: declare an Effect Envelope at start, auto-approve in-envelope actions with Trace evidence, pause in place beyond the envelope, and decide/resume from a CLI Decision Queue, with `forge sessions` gaining running/paused/awaiting-decision states. Budgets gain wall-clock and turn ceilings so an unattended Session cannot run away.

5. Diagnose workflow:
   Add a debugging workflow that follows reproduce, minimize, hypothesize, instrument, fix, and regression-test stages.

6. Test discovery improvements:
   Help Coding Sessions find the right verification command before editing.

7. Model pricing and diagnostics:
   Make provider/model availability, routing, and estimated cost easier to inspect.

8. Local review UI:
   Add an inspect-and-review web surface after the CLI workflows remain stable. Its primary long-term job is reviewing background Session outcomes and Decision Queue items.

9. Shared types decomposition:
   Split `src/types.ts` by owning module: model-client contract types move under `src/models`, session and audit types to their owning modules. Deferred until after the CLI decomposition so its import churn does not pollute those diffs.

## Non-Goals

- Hidden browser automation, cookie access, form submission, or background scraping.
- Silent Durable Memory writes.
- Silent Knowledge Library note creation.
- Undeclared Session starts: no Session begins without an explicit user action or a user-declared schedule, and no hidden observation of the user's activity.
- General life-assistant scope creep; autonomy grows along the declared ladder, not by expanding scope.
- Mutating external Capabilities (writing to external applications through MCP or other providers) until Effect Envelope semantics are proven for external effects.
- Long completed execution plans in `docs/`.

## Durable Constraints

- CLI execution remains first-class.
- Workflows expose only the Capabilities they are granted.
- Trace records real Session events, not simulated progress.
- Active Context can be compacted, but Trace remains immutable evidence.
- Browser context is user-approved read-only input.
- Knowledge Notes are human-facing Markdown artifacts, not Durable Memory.
- Unattended Sessions keep the same evidence bar as interactive ones: every auto-approved action cites the Effect Envelope that authorized it.
- Every Session start traces to an explicit user action or a user-declared schedule.
- ADRs hold durable architectural decisions; `README.md`, `CONTEXT.md`, and this roadmap hold current operating context.
