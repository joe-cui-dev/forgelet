# Forgelet Architecture

Forgelet uses a single-agent ReAct loop with lightweight stage constraints.

```text
intake -> plan -> work -> review -> final
```

The agent loop should depend on abstractions, not vendor-specific or tool-specific implementations:

```text
ModelClient
ToolRegistry
PermissionPolicy
TraceWriter
Workspace
ConfigStore
BudgetTracker
```

## Source Layout

```text
src/cli/          CLI parser and terminal output
src/agent/        Agent orchestration
src/models/       Provider-neutral model interfaces and adapters
src/tools/        Tool registry and built-in tools
src/permissions/  Permission decisions for risky actions
src/config/       Global and project configuration
src/trace/        JSONL session traces
src/context/      ContextAttachment handling
src/workspace/    Workspace discovery and path rules
src/budget/       Token and cost budget tracking
```
