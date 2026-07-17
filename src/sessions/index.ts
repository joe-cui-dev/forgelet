import { basename } from "node:path";
import type { ContextAttachment, SessionAudit, WorkflowKind } from "../types.js";
import { findSessionTracePath, isTraceEvent, listSessionTraceFiles, readTraceFile, type TraceEvent } from "../trace/index.js";
import { isProcessAlive as defaultIsProcessAlive, readPidMarker } from "./pidMarker.js";

export type SessionStatus =
  | "completed"
  | "stopped"
  | "failed"
  | "incomplete"
  | "malformed"
  | "paused"
  | "running";

export interface SessionReadModelOptions {
  /** Injectable pid-liveness probe for deterministic "running" status tests. */
  isProcessAlive?: (pid: number) => boolean;
}

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

export async function listSessions(
  workspaceRoot: string,
  options: SessionReadModelOptions = {},
): Promise<SessionSummary[]> {
  const traceFiles = await listSessionTraceFiles(workspaceRoot);
  const sessions: SessionSummary[] = [];

  for (const tracePath of traceFiles) {
    try {
      const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
      const started = events.find((event) => event.type === "session_started");
      if (!started) continue;

      const task = events.find((event) => event.type === "user_task");
      sessions.push({
        id: started.sessionId,
        workflow: asWorkflow(started.payload.workflow),
        task: typeof task?.payload.task === "string" ? task.payload.task : "",
        taskHash: asTaskHash(started.payload.taskHash),
        startedAt: typeof started.payload.startedAt === "string" ? started.payload.startedAt : started.ts,
        status: await deriveSessionStatus(workspaceRoot, started.sessionId, events, options),
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

async function deriveSessionStatus(
  workspaceRoot: string,
  sessionId: string,
  events: TraceEvent[],
  options: SessionReadModelOptions,
): Promise<SessionStatus> {
  const finished = events.find((event) => event.type === "session_finished");
  if (finished) return asFinishedStatus(finished.payload.status);

  const lastPausedIndex = findLastIndex(events, (event) => event.type === "session_paused");
  const lastResumedIndex = findLastIndex(events, (event) => event.type === "session_resumed");
  if (lastPausedIndex !== -1 && lastPausedIndex > lastResumedIndex) return "paused";

  const pid = await readPidMarker(workspaceRoot, sessionId);
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (pid !== undefined && isProcessAlive(pid)) return "running";
  return "incomplete";
}

function findLastIndex(
  events: TraceEvent[],
  predicate: (event: TraceEvent) => boolean,
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index] as TraceEvent)) return index;
  }
  return -1;
}

function asFinishedStatus(value: unknown): SessionStatus {
  if (value === "completed" || value === "stopped" || value === "failed")
    return value;
  return "incomplete";
}

export async function showSession(
  workspaceRoot: string,
  sessionId: string,
  options: SessionReadModelOptions = {},
): Promise<SessionDetail> {
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
  const started = events.find((event) => event.type === "session_started");
  if (!started) throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  const task = events.find((event) => event.type === "user_task");
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
    status: await deriveSessionStatus(workspaceRoot, started.sessionId, events, options),
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
