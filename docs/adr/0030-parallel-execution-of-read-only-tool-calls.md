# Parallel Execution of Read-Only Tool Calls Within a Turn

Tool calls from a single model turn ran strictly serially (`for … await`), so a turn that asked
for several file reads or searches paid their full latency sum even though none of them depend
on each other or touch shared state. We now execute consecutive read-capability tool calls
within a turn concurrently (capped at 4 at once), while every other call — writes, commands,
plan updates — keeps strict serial order exactly as before.

A tool call is eligible for concurrent execution only if `ToolRegistry.capabilityFor(name)`
(a new lookup, added because the registry previously only reported a tool's capability after
executing it) resolves to `read_context`, `read_workspace`, or `git_read`. This set is safe to
parallelize because those capabilities are always classified at `riskTier: "low"` or
`"forbidden"` (see `src/tools/readOnly.ts`), never `"medium"`, so their permission decision is
always `allow` or `deny` and never `confirm` — the interactive `approvalHandler` is guaranteed
not to be invoked for them, satisfying the rule that it must never run concurrently.
`update_plan` is excluded even though it lives in `readOnly.ts`: it mutates shared `Session`
plan state and is not a read, so it stays serial.

Grouping is structural, not global: a turn's tool calls are partitioned in original order into
runs of consecutive read-capability calls (executed concurrently as one group) and individual
non-read calls (each its own serial group). Groups are processed in sequence, so an actionable
call is never reordered relative to the reads before or after it — only calls immediately
adjacent to each other and both read-capable ever run at the same time.

Two ordering guarantees are preserved despite concurrent execution within a group:

- **Conversation order**: observations are returned in the group's original call order (a
  concurrency-limited map that writes into a results array by index, not by completion order),
  so the model always sees tool results in the order it requested them, regardless of which
  call actually finished first.
- **Trace and Debug Transcript order**: each call's trace/debug events are buffered locally
  during concurrent execution (capturing the real timestamp of the moment they occurred) and
  flushed to the real Trace/Debug Transcript in original call order only after the whole group
  settles. This keeps replay deterministic and keeps every event's timestamp real (ADR 0012) —
  nothing is backdated or fabricated, only the write-out is deferred and reordered. Live events
  (`onLiveEvent`) are exempt from buffering and pass straight through as they occur, since they
  are presentation only (ADR 0015) and are allowed to interleave.

## Considered Options

- **No change (status quo)** — simplest, but a multi-file exploration turn pays the full
  latency sum of every read it requests.
- **Parallelize all tool calls uniformly** — fastest, but risks concurrent invocation of the
  interactive `approvalHandler` for medium-risk actionable calls and reorders writes/commands
  relative to each other, which is unacceptable for audit and correctness.
- **Parallelize only maximal runs of consecutive read-capability calls, capped at 4 (chosen)**
  — captures the common case (a burst of reads) without touching actionable-call ordering or
  approval semantics.

## Consequences

Turns that issue several reads in a row get faster; turns that mix reads with writes/commands
are unaffected in ordering and see no change in outcome, only in the internal execution and
trace-flush mechanics of the read-only stretches. All existing tests pass unchanged since every
prior turn in the test suite issues at most one tool call per model turn or does not use
consecutive read-capability calls, so grouping degenerates to single-item groups identical to
the previous serial behavior.
