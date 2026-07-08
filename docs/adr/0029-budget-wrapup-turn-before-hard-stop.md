# Budget Wrap-Up Turn Before the Hard Token/Cost Stop

The ReAct Node loop was asymmetric: when the **turn** budget neared exhaustion, the model got a
reserved final-answer turn (`finalOnly`) to synthesize what it had found. When **token/cost**
budget neared exhaustion instead, the loop ran cold into the hard stop and the user got a
formatted stopped summary with no model synthesis of the work done so far — a worse outcome
purely because a different resource ran out.

We now check, before each turn, whether usage has crossed 90% of `maxInputTokens` or
`maxEstimatedCostUsd` (a fixed reserve fraction). If so, the loop enters the same tool-free
`finalOnly` path used for turn exhaustion instead of granting another tool-capable turn, and
appends a `budget_wrapup_triggered` Trace event carrying the usage/limit numbers and the
reserve fraction so the decision is auditable. A rolling per-turn-delta projection was
considered and rejected for this first cut: it depends on at least one turn of history to be
meaningful and adds a second heuristic to reason about, where a fixed threshold is simpler to
explain, test, and tune later if 90% proves wrong in practice. The existing post-turn hard
check (blocking tool calls once usage is actually over budget) is unchanged and still serves as
the backstop for when the 90% projection undershoots and the model calls tools anyway on the
reserved turn.

When the wrap-up turn produces usable content, the Session finishes `status: "stopped"` with
the triggering budget reason **and** the model's content attached as `finalContent`, rather than
`status: "completed"`. This lets callers tell a "budget-stopped but summarized" Session apart
from a full completion by checking for `finalContent` on a stopped result. Concretely, this
means `onCompleted` completion effects (e.g. saving a Writing Artifact) do not fire for a
budget-stopped wrap-up: `session.ts` already gates those effects on `status === "completed"`,
so no kernel change was needed there — only the ReAct Node's own return value needed to make
this distinction correctly.

## Considered Options

- **No proactive check (status quo)** — asymmetric with the turn-budget handling and produces
  an unsynthesized stop, which is a worse audit and user experience than any wrap-up.
- **Rolling per-turn-delta projection** — more precise for workloads with wildly uneven
  per-turn cost, but needs turn history to bootstrap and is harder to reason about; deferred
  until the fixed threshold proves insufficient.
- **Fixed 90% reserve fraction (chosen)** — simple, deterministic, and easy to justify and
  test; the existing hard stop remains the backstop for the cases it misses.

## Consequences

A Session nearing its token/cost budget now gets one closing, tool-free turn to summarize
progress before stopping, mirroring the existing turn-budget behavior. That closing turn always
finishes as `stopped`, never `completed`, so it cannot trigger workflow completion side effects;
this is a deliberate, visible behavior change from a full completion, distinguishable via
`finalContent` on the result. All existing tests pass unchanged since the reserve check only
activates once usage already exceeds 90% of a limit.
