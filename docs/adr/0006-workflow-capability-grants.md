# Workflow Capability Grants Gate Tool Calls

Forgelet will authorize tools in two layers: each Workflow receives a default set of Capability grants, and each tool call still passes through PermissionPolicy for allow, confirm, or deny. This prevents a non-code workflow such as writing from accidentally gaining shell or workspace mutation power while preserving fine-grained confirmation for risky coding actions. The model should never gain capability merely by naming a tool.

The model should only be shown tool schemas whose Capabilities are granted to the active Workflow, and dispatch must still re-check the tool Capability before execution. This keeps the model's available action space small while preserving a hard authorization boundary if a provider returns an unexposed or unauthorized tool call.
