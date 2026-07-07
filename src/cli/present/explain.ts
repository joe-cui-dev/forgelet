import type { SessionExplanation } from "../../explain/index.js";
import type { SessionAudit } from "../../types.js";
import { formatList } from "./shared.js";

export function formatSessionExplanation(explanation: SessionExplanation): string {
  return [
    `Session explanation: ${explanation.sessionId}`,
    "",
    "What happened",
    `Status: ${explanation.status}`,
    `Workflow: ${explanation.workflow}`,
    `Task: ${explanation.task || "none"}`,
    explanation.route
      ? `Route: ${explanation.route.model} (${explanation.route.reason})`
      : "Route: none",
    `Model turns: ${explanation.modelTurns}`,
    ...formatEstimatedCost(explanation.audit),
    ...formatMissingEvidence(explanation.missingEvidence),
    "",
    "Tool use",
    ...formatToolResults(explanation.toolResults),
    ...formatConversationCompaction(explanation.compaction),
    "",
    "Permissions and approvals",
    ...formatPermissions(explanation),
    "",
    "Verification and risks",
    ...formatExplanationAudit(explanation.audit),
    "",
    "Agent Kernel takeaways",
    "- Trace records the model turns, tool calls, permission decisions, results, and final audit.",
    "- The explanation is deterministic: it only uses recorded Session evidence.",
  ].join("\n");
}

export function formatConversationCompaction(
  compaction: SessionExplanation["compaction"],
): string[] {
  if (!compaction) return [];
  return [
    "",
    "Conversation compaction:",
    `Passes: ${compaction.passCount}`,
    `Compacted observations: ${compaction.compactedObservations}`,
    `Bytes removed: ${compaction.bytesRemoved}`,
    `Maximum residual overage: ${compaction.maxResidualOverageBytes} bytes`,
  ];
}

export function formatMissingEvidence(missingEvidence: string[]): string[] {
  return missingEvidence.length > 0
    ? [`Missing evidence: ${missingEvidence.join(", ")}`]
    : [];
}

export function formatEstimatedCost(audit: SessionAudit | undefined): string[] {
  return audit ? [`Estimated cost: $${audit.estimatedCostUsd.toFixed(4)}`] : [];
}

export function formatToolResults(
  toolResults: SessionExplanation["toolResults"],
): string[] {
  if (toolResults.length === 0) return ["- none"];
  return toolResults.map(
    (tool) =>
      `- ${tool.toolName}: ${tool.summary || (tool.ok ? "ok" : "failed")}`,
  );
}

export function formatPermissions(explanation: SessionExplanation): string[] {
  const lines = explanation.permissionDecisions.map(
    (decision) =>
      `- ${decision.toolName} requested ${decision.capability} at ${decision.riskTier} risk: ${decision.decision}`,
  );
  lines.push(
    ...explanation.approvalDecisions.map(
      (approval) => `- ${approval.toolName} approval: ${approval.status}`,
    ),
  );
  return lines.length > 0 ? lines : ["- none"];
}

export function formatExplanationAudit(audit: SessionAudit | undefined): string[] {
  if (!audit) return ["No final audit was recorded."];
  return [
    ...(audit.changeGroups.inheritedForgeletChanged &&
    audit.changeGroups.inheritedForgeletChanged.length > 0
      ? [
          `Inherited Forgelet changes: ${formatList(
            audit.changeGroups.inheritedForgeletChanged,
          )}`,
        ]
      : []),
    `Forgelet changed: ${formatList(audit.changeGroups.forgeletChanged)}`,
    audit.verificationCommands.length > 0
      ? "Verification commands:"
      : "Verification commands: none",
    ...audit.verificationCommands.map(
      (command) =>
        `- ${command.command} (${command.timedOut ? "timed out" : `exit ${command.exitCode}`})`,
    ),
    audit.kernelObservedRisks.length > 0
      ? "Kernel-observed risks:"
      : "Kernel-observed risks: none",
    ...audit.kernelObservedRisks.map((risk) => `- ${risk.message}`),
  ];
}
