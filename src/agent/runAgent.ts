import type {
  AgentSession,
  CreativeInputKind,
  CreativeStyle,
  ModelClient,
  WritingArtifact,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";
import { runWorkflowSession } from "../workflows/index.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { LoadedBrowserSnapshot } from "../browser/index.js";
import type { WritingProjectManifest } from "../writingProjects/index.js";

export interface RunAgentInput {
  workflow?: WorkflowKind;
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  creativeInputKind?: CreativeInputKind;
  task: string;
  contextFiles: string[];
  browserSnapshot?: LoadedBrowserSnapshot;
  continuationFile?: string;
  project?: WritingProjectManifest;
  projectReadScopeMembers?: string[];
  allowedReadPaths?: string[];
  model?: string;
  budgetUsd?: number;
  homeDir?: string;
  workspaceRoot: string;
  modelClient?: ModelClient;
  act?: boolean;
  debug?: boolean;
  continuationSourceSessionId?: string;
  approvalHandler?: ApprovalHandler;
  onLiveEvent?: SessionLiveEventSink;
}

export interface RunAgentResult {
  session: AgentSession;
  summary: string;
  tracePath?: string;
  writingArtifact?: WritingArtifact;
}

export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  return runWorkflowSession({
    workflow: input.workflow ?? "coding",
    workflowVariant: input.workflowVariant,
    creativeStyle: input.creativeStyle,
    creativeInputKind: input.creativeInputKind,
    task: input.task,
    contextFiles: input.contextFiles,
    browserSnapshot: input.browserSnapshot,
    continuationFile: input.continuationFile,
    project: input.project,
    projectReadScopeMembers: input.projectReadScopeMembers,
    allowedReadPaths: input.allowedReadPaths,
    model: input.model,
    budgetUsd: input.budgetUsd,
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
    modelClient: input.modelClient,
    act: input.act,
    debug: input.debug,
    continuationSourceSessionId: input.continuationSourceSessionId,
    approvalHandler: input.approvalHandler,
    onLiveEvent: input.onLiveEvent,
  });
}
