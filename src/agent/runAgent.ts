import type { AgentPlan, AgentSession, WorkflowKind } from "../types.js";

export interface RunAgentInput {
  workflow?: WorkflowKind;
  task: string;
  contextFiles: string[];
  model?: string;
  budgetUsd?: number;
  workspaceRoot: string;
}

export interface RunAgentResult {
  session: AgentSession;
  summary: string;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  const now = new Date().toISOString();
  const sessionId = `sess_${Date.now().toString(36)}`;
  const plan: AgentPlan = {
    items: [
      { step: "Load task and workspace context", status: "completed" },
      { step: "Run real agent loop", status: "pending" }
    ]
  };

  const session: AgentSession = {
    id: sessionId,
    workflow: input.workflow ?? "coding",
    task: input.task,
    stage: "final",
    plan,
    createdAt: now
  };

  const details = [
    `Task: ${input.task}`,
    `Workflow: ${input.workflow ?? "coding"}`,
    `Workspace: ${input.workspaceRoot}`,
    input.model ? `Model override: ${input.model}` : "Model override: none",
    input.budgetUsd ? `Budget override: $${input.budgetUsd}` : "Budget override: none",
    input.contextFiles.length > 0 ? `Context files: ${input.contextFiles.join(", ")}` : "Context files: none"
  ];

  return {
    session,
    summary: `Forgelet scaffold is ready. Placeholder run created ${sessionId}.\n${details.join("\n")}`
  };
}
