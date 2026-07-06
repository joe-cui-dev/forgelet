import { findSessionTracePath, readTraceFile } from "../trace/index.js";
import type { ContextAttachment, SessionFinishStatus, WorkflowKind } from "../types.js";

export interface SessionLineage {
  sourceSessionId: string;
  rootSessionId: string;
  sessionIds: string[];
  degraded: boolean;
  incompleteReasons: string[];
  sourceStatus: SessionFinishStatus | "incomplete";
}

export interface ContinuationContext {
  lineage: SessionLineage;
  sourceWorkflow: WorkflowKind;
  inheritedReadScope: string[];
  priorTasks: { sessionId: string; task: string }[];
  priorSummaries: { sessionId: string; summary: string }[];
  priorChangedFiles: { sessionId: string; paths: string[] }[];
  priorVerificationCommands: {
    sessionId: string;
    command: string;
    exitCode: number | null;
    timedOut: boolean;
  }[];
  priorRisks: { sessionId: string; message: string }[];
  contextAttachments: ContextAttachment[];
}

export async function buildSessionLineage(
  workspaceRoot: string,
  sessionId: string,
): Promise<SessionLineage> {
  const events = await readTraceFile(
    await findSessionTracePath(workspaceRoot, sessionId),
  );
  const started = events.find((event) => event.type === "session_started");
  if (!started)
    throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  const finished = events.find((event) => event.type === "session_finished");
  const continuation = asContinuationMetadata(started.payload.continuation);
  const lineageSessionIds = continuation
    ? [...continuation.lineageSessionIds, sessionId]
    : [sessionId];
  const ancestorReasons = await findAncestorIncompleteReasons(
    workspaceRoot,
    lineageSessionIds.slice(0, -1),
  );
  const sourceStatus =
    typeof finished?.payload.status === "string"
      ? asSourceStatus(finished.payload.status)
      : "incomplete";

  return {
    sourceSessionId: sessionId,
    rootSessionId: continuation?.rootSessionId ?? sessionId,
    sessionIds: lineageSessionIds,
    degraded: (continuation?.degraded ?? false) || ancestorReasons.length > 0,
    incompleteReasons: ancestorReasons,
    sourceStatus,
  };
}

export async function buildContinuationContext(
  workspaceRoot: string,
  sessionId: string,
): Promise<ContinuationContext> {
  const lineage = await buildSessionLineage(workspaceRoot, sessionId);
  const eventSets = await Promise.all(
    lineage.sessionIds.map(async (lineageSessionId) => {
      try {
        return {
          sessionId: lineageSessionId,
          events: await readTraceFile(
            await findSessionTracePath(workspaceRoot, lineageSessionId),
          ),
        };
      } catch {
        return { sessionId: lineageSessionId, events: [] };
      }
    }),
  );
  const sourceEvents =
    eventSets.find((eventSet) => eventSet.sessionId === sessionId)?.events ?? [];
  const sourceStarted = sourceEvents.find(
    (event) => event.type === "session_started",
  );

  return {
    lineage,
    sourceWorkflow: asWorkflow(sourceStarted?.payload.workflow),
    inheritedReadScope: asStringArray(sourceStarted?.payload.readScope),
    priorTasks: eventSets.flatMap(({ sessionId, events }) => {
      const task = events.find((event) => event.type === "user_task");
      return typeof task?.payload.task === "string"
        ? [{ sessionId, task: task.payload.task }]
        : [];
    }),
    priorSummaries: eventSets.flatMap(({ sessionId, events }) => {
      const summary = events.find((event) => event.type === "final_summary");
      return typeof summary?.payload.summary === "string"
        ? [{ sessionId, summary: summary.payload.summary }]
        : [];
    }),
    priorChangedFiles: eventSets.flatMap(({ sessionId, events }) => {
      const paths = finalAuditChangedFiles(events);
      return paths.length > 0 ? [{ sessionId, paths }] : [];
    }),
    priorVerificationCommands: eventSets.flatMap(({ sessionId, events }) =>
      finalAuditVerificationCommands(events).map((command) => ({
        sessionId,
        ...command,
      })),
    ),
    priorRisks: eventSets.flatMap(({ sessionId, events }) =>
      finalAuditRiskMessages(events).map((message) => ({ sessionId, message })),
    ),
    contextAttachments: sourceEvents
      .filter((event) => event.type === "context_attachment")
      .map((event) => event.payload as unknown)
      .filter(isContextAttachment),
  };
}

export function formatContinuationContextForPrompt(
  context: ContinuationContext | undefined,
): string[] {
  if (!context) return [];
  const lines = [
    "Continuation Context:",
    `- sourceSessionId: ${context.lineage.sourceSessionId}`,
    `- lineage: ${context.lineage.sessionIds.join(" -> ")}`,
    `- degraded: ${context.lineage.degraded}`,
    `- sourceStatus: ${context.lineage.sourceStatus}`,
  ];
  if (context.inheritedReadScope.length > 0) {
    lines.push(`- inheritedReadScope: ${context.inheritedReadScope.join(", ")}`);
  }
  if (context.priorTasks.length > 0) {
    const priorTask = context.priorTasks[context.priorTasks.length - 1];
    if (priorTask) lines.push(`- priorTask: ${priorTask.task}`);
  }
  if (context.priorSummaries.length > 0) {
    lines.push("- priorSummaries:");
    for (const summary of context.priorSummaries) {
      lines.push(`  - ${summary.sessionId}: ${summary.summary}`);
    }
  }
  if (context.contextAttachments.length > 0) {
    lines.push("- contextAttachments:");
    for (const attachment of context.contextAttachments) {
      lines.push(
        `  - ${attachment.title ?? attachment.id} hash=${attachment.contentHash}`,
      );
    }
  }
  if (
    context.priorChangedFiles.length > 0 ||
    context.priorVerificationCommands.length > 0 ||
    context.priorRisks.length > 0
  ) {
    lines.push("Prior actionable evidence:");
    for (const changed of context.priorChangedFiles) {
      lines.push(
        `- ${changed.sessionId} changed: ${changed.paths.join(", ")}`,
      );
    }
    for (const command of context.priorVerificationCommands) {
      lines.push(
        `- ${command.sessionId} verification: ${command.command} ${
          command.timedOut ? "timed out" : `exit ${command.exitCode}`
        }`,
      );
    }
    for (const risk of context.priorRisks) {
      lines.push(`- ${risk.sessionId} risk: ${risk.message}`);
    }
  }
  return lines;
}

export function continuationContextTracePayload(
  context: ContinuationContext,
): Record<string, unknown> {
  return {
    summaries: context.priorSummaries.length,
    contextAttachments: context.contextAttachments.length,
    inheritedReadScope: context.inheritedReadScope,
    sourceStatus: context.lineage.sourceStatus,
    degraded: context.lineage.degraded,
    priorChangedFiles: context.priorChangedFiles.length,
    priorVerificationCommands: context.priorVerificationCommands.length,
    priorRisks: context.priorRisks.length,
    inheritedChangedPaths: [
      ...new Set(context.priorChangedFiles.flatMap((item) => item.paths)),
    ].sort(),
  };
}

export function formatContinuationHeader(
  context: ContinuationContext,
  newSessionId: string,
): string {
  return [
    `Continuation: ${context.lineage.sourceSessionId} -> ${newSessionId}`,
    `Lineage depth: ${context.lineage.sessionIds.length}`,
    `Context: ${context.lineage.degraded ? "degraded" : "complete"}`,
    ...(context.inheritedReadScope.length > 0
      ? [`Inherited read scope: ${context.inheritedReadScope.join(", ")}`]
      : []),
  ].join("\n");
}

async function findAncestorIncompleteReasons(
  workspaceRoot: string,
  sessionIds: string[],
): Promise<string[]> {
  const reasons: string[] = [];
  for (const sessionId of sessionIds) {
    try {
      const events = await readTraceFile(
        await findSessionTracePath(workspaceRoot, sessionId),
      );
      if (!events.some((event) => event.type === "session_started")) {
        reasons.push(`Ancestor Session trace is malformed: ${sessionId}`);
      }
    } catch {
      reasons.push(`Ancestor Session trace is missing or unreadable: ${sessionId}`);
    }
  }
  return reasons;
}

interface ContinuationMetadata {
  rootSessionId: string;
  lineageSessionIds: string[];
  degraded: boolean;
}

function asContinuationMetadata(value: unknown): ContinuationMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const rootSessionId = value.rootSessionId;
  const lineageSessionIds = value.lineageSessionIds;
  if (
    typeof rootSessionId !== "string" ||
    !Array.isArray(lineageSessionIds) ||
    !lineageSessionIds.every((item) => typeof item === "string")
  ) {
    return undefined;
  }
  return {
    rootSessionId,
    lineageSessionIds,
    degraded: value.degraded === true,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isContextAttachment(value: unknown): value is ContextAttachment {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.source === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.contentBytes === "number" &&
    typeof value.contentHash === "string" &&
    typeof value.preview === "string" &&
    typeof value.trustLevel === "string"
  );
}

function finalAuditChangedFiles(events: { type: string; payload: Record<string, unknown> }[]): string[] {
  const audit = finalAudit(events);
  const changeGroups = isRecord(audit?.changeGroups)
    ? audit.changeGroups
    : undefined;
  return asStringArray(changeGroups?.forgeletChanged).sort();
}

function finalAuditVerificationCommands(
  events: { type: string; payload: Record<string, unknown> }[],
): { command: string; exitCode: number | null; timedOut: boolean }[] {
  const audit = finalAudit(events);
  const commands = Array.isArray(audit?.verificationCommands)
    ? audit.verificationCommands
    : [];
  return commands.flatMap((item) => {
    if (!isRecord(item) || typeof item.command !== "string") return [];
    const exitCode =
      typeof item.exitCode === "number" || item.exitCode === null
        ? item.exitCode
        : null;
    return [
      {
        command: item.command,
        exitCode,
        timedOut: item.timedOut === true,
      },
    ];
  });
}

function finalAuditRiskMessages(
  events: { type: string; payload: Record<string, unknown> }[],
): string[] {
  const audit = finalAudit(events);
  const risks = Array.isArray(audit?.kernelObservedRisks)
    ? audit.kernelObservedRisks
    : [];
  return risks.flatMap((item) =>
    isRecord(item) && typeof item.message === "string" ? [item.message] : [],
  );
}

function finalAudit(
  events: { type: string; payload: Record<string, unknown> }[],
): Record<string, unknown> | undefined {
  const summary = events.find((event) => event.type === "final_summary");
  return isRecord(summary?.payload.audit) ? summary.payload.audit : undefined;
}

function asSourceStatus(value: string): SessionFinishStatus | "incomplete" {
  if (value === "completed" || value === "stopped" || value === "failed")
    return value;
  return "incomplete";
}

function asWorkflow(value: unknown): WorkflowKind {
  if (value === "writing" || value === "learning") return value;
  return "coding";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
