import { basename } from "node:path";
import type { ContextAttachment, SessionAudit, WorkflowKind } from "../types.js";
import { findSessionTracePath, listSessionTraceFiles, readTraceFile } from "../trace/index.js";

export type SessionStatus =
  | "completed"
  | "stopped"
  | "failed"
  | "incomplete"
  | "malformed";

export interface SessionSummary {
  id: string;
  workflow: WorkflowKind;
  task: string;
  taskHash: string;
  startedAt: string;
  status: SessionStatus;
  tracePath: string;
}

export interface SessionRouteSummary {
  model: string;
  reason: string;
}

export interface SessionDetail extends SessionSummary {
  contextAttachments: ContextAttachment[];
  route?: SessionRouteSummary;
  finalSummary: string;
  audit?: SessionAudit;
}

export async function listSessions(workspaceRoot: string): Promise<SessionSummary[]> {
  const traceFiles = await listSessionTraceFiles(workspaceRoot);
  const sessions: SessionSummary[] = [];

  for (const tracePath of traceFiles) {
    try {
      const events = await readTraceFile(tracePath);
      const started = events.find((event) => event.type === "session_started");
      if (!started) continue;

      const task = events.find((event) => event.type === "user_task");
      const finished = events.find((event) => event.type === "session_finished");
      sessions.push({
        id: started.sessionId,
        workflow: asWorkflow(started.payload.workflow),
        task: typeof task?.payload.task === "string" ? task.payload.task : "",
        taskHash: asTaskHash(started.payload.taskHash),
        startedAt: typeof started.payload.startedAt === "string" ? started.payload.startedAt : started.ts,
        status: asSessionStatus(finished?.payload.status),
        tracePath
      });
    } catch {
      sessions.push({
        id: basename(tracePath, ".jsonl"),
        workflow: "coding",
        task: "",
        taskHash: "",
        startedAt: "",
        status: "malformed",
        tracePath
      });
    }
  }

  return sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function asWorkflow(value: unknown): WorkflowKind {
  if (value === "writing" || value === "learning") return value;
  return "coding";
}

function asSessionStatus(value: unknown): SessionStatus {
  if (value === "completed" || value === "stopped" || value === "failed")
    return value;
  return "incomplete";
}

export async function showSession(workspaceRoot: string, sessionId: string): Promise<SessionDetail> {
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const events = await readTraceFile(tracePath);
  const started = events.find((event) => event.type === "session_started");
  if (!started) throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  const task = events.find((event) => event.type === "user_task");
  const finished = events.find((event) => event.type === "session_finished");
  const route = events.find((event) => event.type === "routing_selected");
  const finalSummary = events.find((event) => event.type === "final_summary");
  const contextAttachments = events
    .filter((event) => event.type === "context_attachment")
    .map((event) => event.payload as unknown as ContextAttachment);

  return {
    id: started.sessionId,
    workflow: asWorkflow(started.payload.workflow),
    task: typeof task?.payload.task === "string" ? task.payload.task : "",
    taskHash: asTaskHash(started.payload.taskHash),
    startedAt: typeof started.payload.startedAt === "string" ? started.payload.startedAt : started.ts,
    status: asSessionStatus(finished?.payload.status),
    tracePath,
    contextAttachments,
    route: route ? { model: String(route.payload.model ?? ""), reason: String(route.payload.reason ?? "") } : undefined,
    finalSummary: typeof finalSummary?.payload.summary === "string" ? finalSummary.payload.summary : "",
    audit: asSessionAudit(finalSummary?.payload.audit)
  };
}

function asTaskHash(value: unknown): string {
  return typeof value === "string" ? value : "";
}

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
