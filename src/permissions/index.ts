import type { PermissionPolicy, ToolRequest, ToolTarget } from "../types.js";

export const createPermissionPolicy = (): PermissionPolicy => ({
  async decide(request) {
    if (request.riskTier === "high")
      return {
        kind: "deny",
        riskTier: request.riskTier,
        reason: "High-risk tool requests are denied in V1.",
      };
    if (request.riskTier === "forbidden")
      return {
        kind: "deny",
        riskTier: request.riskTier,
        reason: [
          "Forbidden tool requests are denied",
          deniedTargetReason(request),
        ]
          .filter(Boolean)
          .join(": ")
          .concat("."),
      };
    if (request.riskTier === "medium")
      return {
        kind: "confirm",
        riskTier: request.riskTier,
        reason: "Medium-risk tool request requires confirmation.",
      };
    return {
      kind: "allow",
      riskTier: request.riskTier,
      reason: "Low-risk tool request is allowed.",
    };
  },
});

const deniedTargetReason = (request: ToolRequest): string | undefined => {
  const target = request.targets?.find(isDeniedTarget);
  if (!target) return undefined;
  if (target.kind === "path" && target.classification === "delete_file")
    return `${target.path} delete-file patches are denied`;
  if (target.kind === "path" && target.classification === "dirty_at_session_start")
    return `${target.path} was dirty at Session start`;
  if (target.kind === "path")
    return `${target.path} is ${target.classification}`;
  return `${target.command} is ${target.classification}`;
};

const isDeniedTarget = (target: ToolTarget): boolean => {
  if (target.kind === "path") return target.classification !== "ordinary";
  return target.classification !== "safe_configured";
};

export type { Capability, PermissionDecision, PermissionPolicy, RiskTier, ToolRequest, WorkflowCapabilityGrant } from "../types.js";
