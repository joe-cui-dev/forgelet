import { basename } from "node:path";
import type { ContextAttachment, SessionAudit, WorkflowKind } from "../types.js";
import {
  findSessionTracePath,
  isTraceEvent,
  listSessionTraceFiles,
  readTraceFile,
  type KnownTraceEvent,
} from "../trace/index.js";
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

export interface SessionTraceFold {
  id: string;
  workflow: WorkflowKind;
  task: string;
  taskHash: string;
  startedAt: string;
  finishedAt?: string;
  pausedAt?: string;
  hasFinalSummary: boolean;
  hasFinished: boolean;
  status: Exclude<SessionStatus, "running" | "malformed">;
  route?: SessionRouteSummary;
  finalSummary: string;
  audit?: SessionAudit;
  contextAttachments: ContextAttachment[];
  trigger?: NonNullable<Extract<
    KnownTraceEvent,
    { type: "session_started" }
  >["payload"]["trigger"]>;
}

/** The single lifecycle interpretation of validated Trace evidence. Domain
 * readers may add their own event folds, but must not reconstruct this state. */
export function foldSessionTrace(
  events: KnownTraceEvent[],
): SessionTraceFold | undefined {
  const started = events.find((event) => event.type === "session_started");
  if (!started) return undefined;
  const task = events.find((event) => event.type === "user_task");
  const route = events.find((event) => event.type === "routing_selected");
  const finalSummary = lastEvent(events, "final_summary");
  const finished = lastEvent(events, "session_finished");
  const paused = lastEvent(events, "session_paused");
  // The last lifecycle event decides the state: a failed resume attempt
  // re-arms the pause (ADR 0061), and a retried Session reads by its final
  // outcome even when older attempt evidence recorded a failure.
  const lastLifecycle = events
    .filter(
      (event) =>
        event.type === "session_paused" ||
        event.type === "session_resumed" ||
        event.type === "session_resume_failed" ||
        event.type === "session_finished",
    )
    .at(-1);
  const isPaused =
    paused !== undefined &&
    (lastLifecycle?.type === "session_paused" ||
      lastLifecycle?.type === "session_resume_failed");

  return {
    id: started.sessionId,
    workflow: started.payload.workflow ?? "coding",
    task: task?.payload.task ?? "",
    taskHash: started.payload.taskHash ?? "",
    startedAt: started.payload.startedAt ?? started.ts,
    ...(finished ? { finishedAt: finished.payload.finishedAt ?? finished.ts } : {}),
    ...(isPaused ? { pausedAt: paused.ts } : {}),
    hasFinalSummary: finalSummary !== undefined,
    hasFinished: finished !== undefined,
    status:
      lastLifecycle?.type === "session_finished"
        ? lastLifecycle.payload.status ?? "incomplete"
        : isPaused
          ? "paused"
          : "incomplete",
    ...(route
      ? { route: { model: route.payload.model ?? "", reason: route.payload.reason ?? "" } }
      : {}),
    finalSummary: finalSummary?.payload.summary ?? "",
    ...(finalSummary?.payload.audit ? { audit: finalSummary.payload.audit } : {}),
    contextAttachments: events
      .filter((event) => event.type === "context_attachment")
      .map((event) => event.payload),
    ...(started.payload.trigger ? { trigger: started.payload.trigger } : {}),
  };
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
      const folded = foldSessionTrace(events);
      if (!folded) continue;
      sessions.push({
        id: folded.id,
        workflow: folded.workflow,
        task: folded.task,
        taskHash: folded.taskHash,
        startedAt: folded.startedAt,
        status: await resolveSessionStatus(workspaceRoot, folded, options),
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

async function resolveSessionStatus(
  workspaceRoot: string,
  folded: SessionTraceFold,
  options: SessionReadModelOptions,
): Promise<SessionStatus> {
  if (folded.status !== "incomplete") return folded.status;

  const pid = await readPidMarker(workspaceRoot, folded.id);
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (pid !== undefined && isProcessAlive(pid)) return "running";
  return "incomplete";
}

function lastEvent<Type extends KnownTraceEvent["type"]>(
  events: KnownTraceEvent[],
  type: Type,
): Extract<KnownTraceEvent, { type: Type }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === type)
      return event as Extract<KnownTraceEvent, { type: Type }>;
  }
  return undefined;
}

export async function showSession(
  workspaceRoot: string,
  sessionId: string,
  options: SessionReadModelOptions = {},
): Promise<SessionDetail> {
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
  const folded = foldSessionTrace(events);
  if (!folded) throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  return {
    id: folded.id,
    workflow: folded.workflow,
    task: folded.task,
    taskHash: folded.taskHash,
    startedAt: folded.startedAt,
    status: await resolveSessionStatus(workspaceRoot, folded, options),
    tracePath,
    contextAttachments: folded.contextAttachments,
    route: folded.route,
    finalSummary: folded.finalSummary,
    audit: folded.audit,
  };
}
