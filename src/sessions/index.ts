import { basename } from "node:path";
import type { ContextAttachment, WorkflowKind } from "../types.js";
import { listSessionTraceFiles, readTraceFile, sessionTracePath } from "../trace/index.js";

export type SessionStatus = "completed" | "incomplete" | "malformed";

export interface SessionSummary {
  id: string;
  workflow: WorkflowKind;
  task: string;
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
        startedAt: typeof started.payload.startedAt === "string" ? started.payload.startedAt : started.ts,
        status: finished ? "completed" : "incomplete",
        tracePath
      });
    } catch {
      sessions.push({
        id: basename(tracePath, ".jsonl"),
        workflow: "coding",
        task: "",
        startedAt: "",
        status: "malformed",
        tracePath
      });
    }
  }

  return sessions.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

function asWorkflow(value: unknown): WorkflowKind {
  return value === "writing" ? "writing" : "coding";
}

export async function showSession(workspaceRoot: string, sessionId: string): Promise<SessionDetail> {
  const tracePath = sessionTracePath(workspaceRoot, sessionId);
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
    startedAt: typeof started.payload.startedAt === "string" ? started.payload.startedAt : started.ts,
    status: finished ? "completed" : "incomplete",
    tracePath,
    contextAttachments,
    route: route ? { model: String(route.payload.model ?? ""), reason: String(route.payload.reason ?? "") } : undefined,
    finalSummary: typeof finalSummary?.payload.summary === "string" ? finalSummary.payload.summary : ""
  };
}
