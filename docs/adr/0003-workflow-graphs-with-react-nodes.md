# Workflow Graphs with ReAct Nodes

Forgelet will use explicit Workflow Graphs as the outer execution model, with bounded ReAct Nodes inside stages that need exploration or tool use. The earlier single generic ReAct loop is too narrow for a personal agent platform because coding, diagnosis, writing, learning, and image workflows need different reliable stage shapes. V1 can still implement a small coding graph first, but it should not bake a single loop into the Agent Kernel.
