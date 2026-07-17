import type { SessionAudit, WorkflowKind } from "../types.js";
import { foldSessionTrace } from "../sessions/index.js";
import { findSessionTracePath, isTraceEvent, readTraceFile, type KnownTraceEvent } from "../trace/index.js";

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
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
  const folded = foldSessionTrace(events);
  if (!folded)
    throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  return {
    sessionId,
    workflow: folded.workflow,
    status: folded.status,
    task: folded.task,
    route: folded.route,
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
    audit: folded.audit,
    missingEvidence: [
      ...(folded.hasFinalSummary ? [] : ["final_summary"]),
      ...(folded.hasFinished ? [] : ["session_finished"]),
    ],
  };
}

const explainConversationCompaction = (
  events: KnownTraceEvent[],
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
          asNumber(event.payload.beforeConversationBytes) -
            asNumber(event.payload.afterConversationBytes),
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
  event: Extract<KnownTraceEvent, { type: "tool_result" }>,
): ToolResultExplanation => ({
  toolName: String(event.payload.toolName ?? ""),
  summary: String(event.payload.summary ?? ""),
  ok: event.payload.ok === true,
});

const toPermissionExplanation = (
  event: Extract<KnownTraceEvent, { type: "permission_decision" }>,
): PermissionExplanation => ({
  toolName: String(event.payload.toolName ?? ""),
  capability: String(event.payload.capability ?? ""),
  riskTier: String(event.payload.riskTier ?? ""),
  decision: String(event.payload.decision ?? ""),
  reason: String(event.payload.reason ?? ""),
});

const toApprovalExplanation = (
  event: Extract<KnownTraceEvent, { type: "approval_decision" }>,
): ApprovalExplanation => ({
  toolName: String(event.payload.toolName ?? ""),
  status: String(event.payload.status ?? ""),
  reason: String(event.payload.reason ?? ""),
});

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
