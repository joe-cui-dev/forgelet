import type {
  AgentSession,
  CreativeStyle,
  ModelClient,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";
import { runWorkflowSession } from "../workflows/index.js";

export interface RunAgentInput {
  workflow?: WorkflowKind;
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  task: string;
  contextFiles: string[];
  allowedReadPaths?: string[];
  model?: string;
  budgetUsd?: number;
  homeDir?: string;
  workspaceRoot: string;
  modelClient?: ModelClient;
  act?: boolean;
  approvalHandler?: ApprovalHandler;
}

export interface RunAgentResult {
  session: AgentSession;
  summary: string;
  tracePath?: string;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  return runWorkflowSession({
    workflow: input.workflow ?? "coding",
    workflowVariant: input.workflowVariant,
    creativeStyle: input.creativeStyle,
    task: input.task,
    contextFiles: input.contextFiles,
    allowedReadPaths: input.allowedReadPaths,
    model: input.model,
    budgetUsd: input.budgetUsd,
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
    modelClient: input.modelClient,
    act: input.act,
    approvalHandler: input.approvalHandler,
  });
}
