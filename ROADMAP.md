# Forgelet Roadmap

Forgelet is a local-first personal Agent Kernel with a CLI-first surface. V1 is dogfoodable: Coding Sessions can inspect, edit with approval, verify, and explain changes; Writing and Learning workflows can produce saved artifacts and source-linked outputs.

## Current Product Shape

Forgelet should remain a workbench for code, writing, learning, browser context, knowledge notes, and durable memory. It should not become a hidden autonomous assistant. Durable writes, command execution, memory persistence, and external effects require explicit boundaries and trace evidence.

Current implemented surfaces:

- `forge code` for read-only and actionable Coding Sessions, including `--write-scope`/`--allow-command` Background Sessions that declare an Effect Envelope, auto-approve in-envelope confirmable actions, and pause in place beyond it.
- `forge queue` and `forge decide <sessionId>` for the Decision Queue: listing paused Sessions and deciding (approve/deny/approve-and-widen/stop) to resume them in place.
- `forge write` for prose revision, creative drafting, browser-backed writing, saved Writing Artifacts, artifact continuation, Writing Project continuity, and artifact catalog search.
- `forge learn` for source-backed Learning Packs from files or browser context.
- `forge learn --web` for bounded, source-ledger-backed Public Web Learning through Brave Search or an offline fake provider.
- Browser Workbench for one-gesture current-page Page Briefs with bounded, source-grounded follow-up Page Conversations in the Side Panel, a user-chosen output language, Stop/Retry, and per-window reattachment.
- `forge notes create/search` for project-scope Knowledge Notes promoted from completed Learning Sessions.
- `forge browser read-current` and `forge browser install-host` for read-only browser snapshots.
- `forge resume` for child Session Continuations.
- `forge sessions` (with `running` and `paused` states), `forge explain`, and config commands for review and operation.
- `forge memory suggest` for versioned, idempotent Memory Suggestions, and Project Memory Review (`forge memory list/show/accept/reject`) for a guided, deterministic, model-free decision queue over them, backed by the append-only Memory Decision Log (ADR 0035).

## Long-Term Direction

Forgelet's destination is a bounded autonomous agent: it acts on the user's behalf under declared authority, never hidden, always evidenced. Autonomy grows along a declared ladder, and every rung reuses the same kernel boundaries — Capabilities, Permission Policy, Effect Envelope, budget, and Trace — rather than inventing parallel trust mechanisms.

1. Background Sessions (first rung):
   The user starts a long task interactively, declares an Effect Envelope — write scope, command allowlist, budget — and leaves. The Session continues unattended, auto-approving confirmable actions inside the envelope with Trace evidence, and pauses in place as the same Session when it needs anything outside it (ADR 0026, ADR 0027). Paused Sessions surface in a CLI Decision Queue, and deciding from the queue resumes the Session; finished Sessions surface with their outcomes in `forge sessions`, not in the queue. The CLI remains the decision surface; the Local Review UI stays sequenced per ADR 0009, with its long-term job re-framed as the richer review surface for background outcomes.

2. Memory depth before frequency:
   Unattended runs replace interactive steering with remembered guidance, so memory quality gates the ladder. Durable Memory gains a personal Memory Scope alongside project scope, and whole-file injection is replaced by bounded Memory Recall recorded as Trace evidence. Writes stay user-approved per ADR 0007; memory suggestions produced by background Sessions land in the Decision Queue.

3. Scheduled Routines paired with read-only external sources:
   Recurring user-declared Sessions — nightly repo digests, learning review packs — reuse the Effect Envelope and the Decision Queue; the scheduler is the only new part. They advance together with read-only external Tool Providers (issue trackers, docs, feeds) whose output enters Sessions as Context Attachments, following the Browser Context Bridge precedent, because routine runs without fresh external input produce mediocre output.

Far-future and not committed: event-triggered Sessions, proactive suggestions, and mutating external Capabilities. The gate for external mutation is Effect Envelope semantics proven for external effects. What stays banned is concealment, not autonomy: every Session start must trace to an explicit user action or a user-declared schedule.

## Next Candidate Slices

1. Diagnose workflow:
   Add a debugging workflow that follows reproduce, minimize, hypothesize, instrument, fix, and regression-test stages.

2. Test discovery improvements:
   Help Coding Sessions find the right verification command before editing.

3. Model pricing and diagnostics:
   Make provider/model availability, routing, and estimated cost easier to inspect.

4. Local review UI:
   Add an inspect-and-review web surface after the CLI workflows remain stable. Its primary long-term job is reviewing background Session outcomes and Decision Queue items.

5. Shared types decomposition:
   Split `src/types.ts` by owning module: model-client contract types move under `src/models`, session and audit types to their owning modules. Unblocked now that the CLI decomposition has landed.

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
