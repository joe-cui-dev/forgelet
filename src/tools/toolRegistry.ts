import type {
  Capability,
  ModelToolCall,
  PermissionDecision,
  ToolContext,
  ToolDefinition,
  ToolObservation,
  ToolSchema,
} from "../types.js";
import {
  deniedToolObservation,
  toolResultToObservation,
  unknownToolObservation,
} from "./observations.js";

export interface ToolRegistry {
  listTools(grantedCapabilities: readonly Capability[]): ToolSchema[];
  execute(
    toolCall: ModelToolCall,
    ctx: ToolContext,
  ): Promise<ToolRegistryExecution>;
}

export interface ToolRegistryExecution {
  observation: ToolObservation;
  permissionDecision: PermissionDecision;
  capability?: Capability;
}

export const createToolRegistry = (
  tools: readonly ToolDefinition[],
): ToolRegistry => {
  const seen = new Set<string>();
  for (const tool of tools) {
    validateToolMetadata(tool);
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }
  return {
    listTools(grantedCapabilities) {
      return tools
        .filter((tool) => grantedCapabilities.includes(tool.capability))
        .map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        }));
    },
    async execute(toolCall, ctx) {
      const tool = tools.find((candidate) => candidate.name === toolCall.name);
      if (!tool) {
        const observation = unknownToolObservation(toolCall.id, toolCall.name);
        return {
          observation,
          permissionDecision: {
            kind: "deny",
            riskTier: "forbidden",
            reason: observation.summary,
          },
        };
      }
      if (!ctx.grantedCapabilities.includes(tool.capability)) {
        const message = `Capability not granted: ${tool.capability}`;
        return {
          observation: deniedToolObservation(toolCall.id, toolCall.name, message),
          permissionDecision: {
            kind: "deny",
            riskTier: "forbidden",
            reason: message,
          },
          capability: tool.capability,
        };
      }
      const permissionDecision: PermissionDecision = {
        kind: "allow",
        riskTier: "low",
        reason: "Workflow capability grant allows tool.",
      };
      try {
        const result = await tool.execute(toolCall.input, ctx);
        return {
          observation: toolResultToObservation(
            result,
            toolCall.id,
            toolCall.name,
          ),
          permissionDecision,
          capability: tool.capability,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          observation: {
            ok: false,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            summary: message,
            error: { code: "invalid_input", message },
            metadata: {},
          },
          permissionDecision,
          capability: tool.capability,
        };
      }
    },
  };
};

const validateToolMetadata = (tool: ToolDefinition): void => {
  if (!tool.name) throw new Error("Tool is missing name");
  if (!tool.providerId) throw new Error(`Tool ${tool.name} is missing providerId`);
  if (!tool.capability) throw new Error(`Tool ${tool.name} is missing capability`);
  if (!tool.description)
    throw new Error(`Tool ${tool.name} is missing description`);
  if (!tool.inputSchema)
    throw new Error(`Tool ${tool.name} is missing inputSchema`);
};
