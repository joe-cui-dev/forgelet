import type { SessionAudit, TraceEvent, WorkflowKind } from "../types.js";
import { readTraceFile, sessionTracePath } from "../trace/index.js";

export interface SessionExplanation {
  sessionId: string;
  workflow: WorkflowKind;
  status: string;
  task: string;
  route?: {
    model: string;
    reason: string;
  };
  modelTurns: number;
  toolResults: ToolResultExplanation[];
  permissionDecisions: PermissionExplanation[];
  approvalDecisions: ApprovalExplanation[];
  compaction?: ConversationCompactionExplanation;
  audit?: SessionAudit;
  missingEvidence: string[];
}

export interface ConversationCompactionExplanation {
  passCount: number;
  compactedObservations: number;
  bytesRemoved: number;
  maxResidualOverageBytes: number;
}

export interface ToolResultExplanation {
  toolName: string;
  summary: string;
  ok: boolean;
}

export interface PermissionExplanation {
  toolName: string;
  capability: string;
  riskTier: string;
  decision: string;
  reason: string;
}

export interface ApprovalExplanation {
  toolName: string;
  status: string;
  reason: string;
}

export async function explainSession(
  workspaceRoot: string,
  sessionId: string,
): Promise<SessionExplanation> {
  const tracePath = sessionTracePath(workspaceRoot, sessionId);
  const events = await readTraceFile(tracePath);
  const started = events.find((event) => event.type === "session_started");
  if (!started)
    throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  const task = events.find((event) => event.type === "user_task");
  const route = events.find((event) => event.type === "routing_selected");
  const finished = events.find((event) => event.type === "session_finished");
  const finalSummary = events.find((event) => event.type === "final_summary");

  return {
    sessionId,
    workflow: asWorkflow(started.payload.workflow),
    status: typeof finished?.payload.status === "string"
      ? finished.payload.status
      : "incomplete",
    task: typeof task?.payload.task === "string" ? task.payload.task : "",
    route: route
      ? {
          model: String(route.payload.model ?? ""),
          reason: String(route.payload.reason ?? ""),
        }
      : undefined,
    modelTurns: events.filter((event) => event.type === "model_turn").length,
    toolResults: events
      .filter((event) => event.type === "tool_result")
      .map(toToolResultExplanation),
    permissionDecisions: events
      .filter((event) => event.type === "permission_decision")
      .map(toPermissionExplanation),
    approvalDecisions: events
      .filter((event) => event.type === "approval_decision")
      .map(toApprovalExplanation),
    compaction: explainConversationCompaction(events),
    audit: asSessionAudit(finalSummary?.payload.audit),
    missingEvidence: [
      ...(finalSummary ? [] : ["final_summary"]),
      ...(finished ? [] : ["session_finished"]),
    ],
  };
}

const explainConversationCompaction = (
  events: TraceEvent[],
): ConversationCompactionExplanation | undefined => {
  const compactionEvents = events.filter(
    (event) =>
      event.type === "conversation_compacted" ||
      event.type === "conversation_compaction_attempted",
  );
  if (compactionEvents.length === 0) return undefined;
  return {
    passCount: compactionEvents.length,
    compactedObservations: compactionEvents.reduce(
      (total, event) => total + asNumber(event.payload.compactedCount),
      0,
    ),
    bytesRemoved: compactionEvents.reduce(
      (total, event) =>
        total +
        Math.max(
          0,
          asNumber(event.payload.beforeObservationBytes) -
            asNumber(event.payload.afterObservationBytes),
        ),
      0,
    ),
    maxResidualOverageBytes: Math.max(
      ...compactionEvents.map((event) =>
        asNumber(event.payload.residualOverageBytes),
      ),
    ),
  };
};

const toToolResultExplanation = (
  event: TraceEvent,
): ToolResultExplanation => ({
  toolName: String(event.payload.toolName ?? ""),
  summary: String(event.payload.summary ?? ""),
  ok: event.payload.ok === true,
});

const toPermissionExplanation = (
  event: TraceEvent,
): PermissionExplanation => ({
  toolName: String(event.payload.toolName ?? ""),
  capability: String(event.payload.capability ?? ""),
  riskTier: String(event.payload.riskTier ?? ""),
  decision: String(event.payload.decision ?? ""),
  reason: String(event.payload.reason ?? ""),
});

const toApprovalExplanation = (
  event: TraceEvent,
): ApprovalExplanation => ({
  toolName: String(event.payload.toolName ?? ""),
  status: String(event.payload.status ?? ""),
  reason: String(event.payload.reason ?? ""),
});

const asWorkflow = (value: unknown): WorkflowKind =>
  value === "writing" || value === "learning" ? value : "coding";

function asSessionAudit(value: unknown): SessionAudit | undefined {
  return isRecord(value) &&
    isRecord(value.changeGroups) &&
    Array.isArray(value.changeGroups.forgeletChanged) &&
    Array.isArray(value.changeGroups.preExistingAtSessionStart) &&
    Array.isArray(value.changeGroups.otherCurrentWorkspaceChanges) &&
    Array.isArray(value.verificationCommands) &&
    Array.isArray(value.kernelObservedRisks) &&
    typeof value.modelTurns === "number" &&
    typeof value.estimatedCostUsd === "number" &&
    typeof value.tracePath === "string"
    ? value as unknown as SessionAudit
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
