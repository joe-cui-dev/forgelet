# Tool Providers Declare Capabilities

Forgelet will model tools as coming from Tool Providers that declare permission-relevant Capabilities. V1 may only ship workspace and shell providers, but the architecture should not treat future browser, writing, MCP, Stable Diffusion, or Photoshop tools as a flat list of unrelated tool names. This keeps permissions, trace events, and workflow design stable as Forgelet grows from a coding workflow into a personal agent platform.
