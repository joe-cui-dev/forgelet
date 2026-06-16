import type { AgentPlan, AgentSession, TraceEvent, WorkflowKind } from "../types.js";
import { loadConfig, routeModel } from "../config/index.js";
import { loadContextAttachments } from "../context/index.js";
import { createTraceWriter } from "../trace/index.js";

export interface RunWorkflowInput {
  workflow: WorkflowKind;
  task: string;
  contextFiles: string[];
  model?: string;
  budgetUsd?: number;
  workspaceRoot: string;
}

export interface RunWorkflowResult {
  session: AgentSession;
  summary: string;
  tracePath: string;
}

export async function runWorkflowSession(input: RunWorkflowInput): Promise<RunWorkflowResult> {
  const now = new Date().toISOString();
  const sessionId = `sess_${Date.now().toString(36)}`;
  const traceWriter = await createTraceWriter(input.workspaceRoot, sessionId);
  const config = await loadConfig({ workspaceRoot: input.workspaceRoot });
  const contextAttachments = await loadContextAttachments(input.workspaceRoot, input.contextFiles);
  const route = selectRoute(input.workflow, routeModel(config, input.workflow, input.model));
  const plan: AgentPlan = {
    items: [
      { step: "Create session and load task context", status: "completed" },
      { step: "Run workflow graph with model and tools", status: "pending" }
    ]
  };

  const session: AgentSession = {
    id: sessionId,
    workflow: input.workflow,
    task: input.task,
    stage: "final",
    plan,
    createdAt: now
  };

  await traceWriter.append(event(sessionId, "session_started", now, { workflow: input.workflow, startedAt: now }));
  await traceWriter.append(event(sessionId, "user_task", now, { task: input.task }));
  for (const contextAttachment of contextAttachments) {
    await traceWriter.append(event(sessionId, "context_attachment", now, contextAttachment.attachment as unknown as Record<string, unknown>));
  }
  await traceWriter.append(event(sessionId, "routing_selected", now, route));
  await traceWriter.append(event(sessionId, "plan_update", now, { plan }));
  await traceWriter.append(event(sessionId, "final_summary", now, { summary: "Execution is scaffolded; no model turn was run." }));
  await traceWriter.append(event(sessionId, "session_finished", now, { status: "completed", finishedAt: now }));

  const details = [
    `Forgelet session created: ${sessionId}`,
    `Workflow: ${input.workflow}`,
    `Task: ${input.task}`,
    input.contextFiles.length > 0 ? `Context attachments: ${input.contextFiles.join(", ")}` : "Context attachments: none",
    `Route: ${route.model} (${route.reason})`,
    "Execution: scaffold only; no model turn was run.",
    `Trace: ${traceWriter.tracePath}`
  ];

  return {
    session,
    summary: details.join("\n"),
    tracePath: traceWriter.tracePath
  };
}

function selectRoute(workflow: WorkflowKind, selected: { model: string; reason: string }): { workflow: WorkflowKind; stage: "act_loop"; model: string; reason: string } {
  return { workflow, stage: "act_loop", model: selected.model, reason: selected.reason };
}

function event(sessionId: string, type: string, ts: string, payload: Record<string, unknown>): TraceEvent {
  return { type, ts, sessionId, payload };
}
