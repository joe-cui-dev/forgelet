# Forgelet Architecture

Forgelet uses workflow graphs with bounded ReAct nodes. V1 starts with a usable coding workflow graph and a lightweight writing workflow skeleton, while the core engine remains reusable for research, image work, learning, and other personal workflows.

```text
intake -> inspect -> plan -> act_loop -> verify -> review -> final
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
WorkflowRunner
```

## Source Layout

```text
src/cli/          CLI parser and terminal output
src/agent/        Agent orchestration
src/workflows/    Workflow graph definitions
src/models/       Provider-neutral model interfaces and adapters
src/tools/        Tool registry and built-in tools
src/permissions/  Permission decisions for risky actions
src/config/       Global and project configuration
src/trace/        JSONL session traces
src/context/      ContextAttachment handling
src/workspace/    Workspace discovery and path rules
src/budget/       Token and cost budget tracking
```
