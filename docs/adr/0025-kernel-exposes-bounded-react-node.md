# Agent Kernel Exposes a Bounded ReAct Node as Its Primitive

The Agent Kernel promised by `CONTEXT.md` and ADR 0003 currently lives fused inside `src/workflows/index.ts` as one generic loop with per-workflow branches — the exact shape ADR 0003 rejected. We will extract the kernel with "run one bounded ReAct Node" (model turns, tool execution, permissions, budget, Active Context compaction, Trace) plus a Session shell as its API. Existing Workflows become single-node graphs that declare their customizations (capability grants, system prompt, final-output normalization, completion hooks, attachment loading) through a WorkflowDefinition interface, and each Workflow exposes its own typed session entry point; the pass-through `runAgent` facade and its workflow-specific leaked fields are removed. Extraction is behavior-preserving: kernel code must contain no workflow-name literals, and all existing tests must pass unchanged.

## Considered Options

- **Extract the whole session loop as-is** — cheapest, but bakes the single generic loop into the kernel API, which ADR 0003 explicitly forbids, forcing a second split later.
- **Implement full Workflow Graph orchestration now** — mixes redesign into a refactor; deferred until the first genuinely multi-stage workflow (the Diagnose workflow) needs it.
- **Bounded ReAct Node primitive, graphs deferred (chosen)** — behavior-preserving today, and the node granularity means adding a graph layer later composes nodes without changing the kernel.

## Consequences

This does not abandon ADR 0003; it records its staged fulfilment. Until a graph layer exists, "single-node graph" is the only supported workflow shape.
