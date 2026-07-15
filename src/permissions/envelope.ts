import { dirname, normalize } from "node:path";
import type { ModelToolCall, ToolRequest, ToolTarget } from "../types.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";

export interface EffectEnvelope {
  writeScopePrefixes: string[];
  allowedCommands: string[];
}

export class SessionPauseSignal extends Error {
  readonly toolCall: ModelToolCall;
  readonly toolRequest: ToolRequest;

  constructor(input: { toolCall: ModelToolCall; toolRequest: ToolRequest }) {
    super(
      `Session pause: ${input.toolCall.name} is out of the declared Effect Envelope.`,
    );
    this.name = "SessionPauseSignal";
    this.toolCall = input.toolCall;
    this.toolRequest = input.toolRequest;
  }
}

export const createEnvelopeApprovalHandler = (
  envelope: EffectEnvelope,
): ApprovalHandler => {
  return async (request) => {
    if (isWithinEnvelope(request.toolRequest, envelope))
      return {
        status: "approved",
        reason: citeEnvelope(request.toolRequest),
      };
    throw new SessionPauseSignal({
      toolCall: request.toolCall,
      toolRequest: request.toolRequest,
    });
  };
};

export const createResumeApprovalHandler = (
  pendingToolCallId: string,
  action: "approve" | "deny",
  envelope: EffectEnvelope,
  denyReason: string,
): ApprovalHandler => {
  const envelopeHandler = createEnvelopeApprovalHandler(envelope);
  let resolved = false;
  return async (request) => {
    if (!resolved && request.toolCall.id === pendingToolCallId) {
      resolved = true;
      return action === "approve"
        ? { status: "approved", reason: "Approved by user via `forge decide`." }
        : { status: "rejected", reason: denyReason };
    }
    return envelopeHandler(request);
  };
};

export const widenEnvelopeForRequest = (
  envelope: EffectEnvelope,
  request: ToolRequest,
): EffectEnvelope => {
  const writeScopePrefixes = new Set(envelope.writeScopePrefixes);
  const allowedCommands = new Set(envelope.allowedCommands);
  for (const target of request.targets ?? []) {
    if (target.kind === "path") writeScopePrefixes.add(dirname(target.path));
    if (target.kind === "command") allowedCommands.add(target.command);
  }
  return {
    writeScopePrefixes: [...writeScopePrefixes],
    allowedCommands: [...allowedCommands],
  };
};

const citeEnvelope = (request: ToolRequest): string => {
  const citations = (request.targets ?? []).map((target) =>
    target.kind === "path"
      ? `${target.path} is within the declared write scope`
      : target.kind === "command"
        ? `${target.command} is in the declared command allowlist`
        : `${target.url} is not governed by the Effect Envelope`,
  );
  return citations.length > 0
    ? `Auto-approved by the declared Effect Envelope: ${citations.join("; ")}.`
    : "Auto-approved by the declared Effect Envelope.";
};

export const isWithinEnvelope = (
  request: ToolRequest,
  envelope: EffectEnvelope,
): boolean => {
  const targets = request.targets ?? [];
  return targets.every((target) => isTargetWithinEnvelope(target, envelope));
};

const isTargetWithinEnvelope = (
  target: ToolTarget,
  envelope: EffectEnvelope,
): boolean => {
  if (target.kind === "path")
    return (
      target.classification === "ordinary" &&
      envelope.writeScopePrefixes.some((prefix) =>
        isPathUnderPrefix(target.path, prefix),
      )
    );
  if (target.kind === "url") return false;
  return (
    target.classification === "safe_configured" &&
    envelope.allowedCommands.includes(target.command)
  );
};

const isPathUnderPrefix = (path: string, prefix: string): boolean => {
  if (prefix === ".") return true;
  const normalizedPath = normalize(path);
  const normalizedPrefix = normalize(prefix);
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
};
