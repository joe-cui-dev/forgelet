import type {
  ApprovalDecision,
  Capability,
  ModelToolCall,
  PermissionDecision,
  PermissionPolicy,
  ToolContext,
  ToolDefinition,
  ToolObservation,
  ToolRequest,
  ToolSchema,
} from "../types.js";
import { createPermissionPolicy } from "../permissions/index.js";
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

export type ApprovalHandler = (
  request: ApprovalRequest,
) => Promise<ApprovalDecision>;

export interface ApprovalRequest {
  toolCall: ModelToolCall;
  toolRequest: ToolRequest;
  permissionDecision: PermissionDecision;
}

export interface ToolRegistryOptions {
  permissionPolicy?: PermissionPolicy;
  approvalHandler?: ApprovalHandler;
}

export interface ToolRegistryExecution {
  observation: ToolObservation;
  permissionDecision: PermissionDecision;
  approvalDecision?: ApprovalDecision;
  capability?: Capability;
}

export const createToolRegistry = (
  tools: readonly ToolDefinition[],
  options: ToolRegistryOptions = {},
): ToolRegistry => {
  const permissionPolicy = options.permissionPolicy ?? createPermissionPolicy();
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
      const request = tool.classify
        ? await tool.classify(toolCall.input, ctx)
        : {
            workflow: ctx.workflow,
            toolName: tool.name,
            capability: tool.capability,
            riskTier: "low" as const,
            input: toolCall.input,
            workspaceRoot: ctx.workspaceRoot,
            targets: [],
          };
      const permissionDecision = await permissionPolicy.decide(request);
      if (permissionDecision.kind === "deny") {
        return {
          observation: deniedToolObservation(
            toolCall.id,
            toolCall.name,
            permissionDecision.reason,
          ),
          permissionDecision,
          capability: tool.capability,
        };
      }
      let approvalDecision: ApprovalDecision | undefined;
      if (permissionDecision.kind === "confirm") {
        approvalDecision = options.approvalHandler
          ? await options.approvalHandler({
              toolCall,
              toolRequest: request,
              permissionDecision,
            })
          : {
              status: "unavailable" as const,
              reason: "No approval handler is available.",
            };
        if (approvalDecision.status !== "approved") {
          const message =
            approvalDecision.status === "unavailable"
              ? `Approval unavailable for ${toolCall.name}.`
              : `Approval rejected for ${toolCall.name}.`;
          return {
            observation: deniedToolObservation(toolCall.id, toolCall.name, message),
            permissionDecision,
            approvalDecision,
            capability: tool.capability,
          };
        }
      }
      try {
        const result = await tool.execute(toolCall.input, ctx);
        return {
          observation: toolResultToObservation(
            result,
            toolCall.id,
            toolCall.name,
          ),
          permissionDecision,
          approvalDecision,
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
          approvalDecision,
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
