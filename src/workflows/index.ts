import type { LoadedBrowserSnapshot } from "../browser/index.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";
import type {
  AgentSession,
  CreativeInputKind,
  CreativeStyle,
  ModelClient,
  WritingArtifact,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import type { WritingProjectManifest } from "../writingProjects/index.js";
import {
  runCodingSession,
  type CodingSessionResult,
} from "./coding.js";
import {
  runLearningSession,
  type LearningSessionResult,
} from "./learning.js";
import {
  runWritingSession,
  type WritingSessionResult,
} from "./writing.js";

export {
  createCodingWorkflowDefinition,
  runCodingSession,
} from "./coding.js";
export {
  createLearningWorkflowDefinition,
  runLearningSession,
} from "./learning.js";
export {
  createWritingWorkflowDefinition,
  runWritingSession,
} from "./writing.js";

export interface RunWorkflowInput {
  workflow: WorkflowKind;
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

export interface RunWorkflowResult {
  session: AgentSession;
  summary: string;
  tracePath: string;
  writingArtifact?: WritingArtifact;
}

export async function runWorkflowSession(
  input: RunWorkflowInput,
): Promise<RunWorkflowResult> {
  if (input.workflow === "writing")
    return runWritingSession({
      task: input.task,
      contextFiles: input.contextFiles,
      browserSnapshot: input.browserSnapshot,
      workflowVariant: input.workflowVariant,
      creativeStyle: input.creativeStyle,
      creativeInputKind: input.creativeInputKind,
      continuationFile: input.continuationFile,
      project: input.project,
      projectReadScopeMembers: input.projectReadScopeMembers,
      allowedReadPaths: input.allowedReadPaths,
      model: input.model,
      budgetUsd: input.budgetUsd,
      homeDir: input.homeDir,
      workspaceRoot: input.workspaceRoot,
      modelClient: input.modelClient,
      debug: input.debug,
      approvalHandler: input.approvalHandler,
      onLiveEvent: input.onLiveEvent,
    }) satisfies Promise<WritingSessionResult>;

  if (input.workflow === "learning")
    return runLearningSession({
      task: input.task,
      contextFiles: input.contextFiles,
      browserSnapshot: input.browserSnapshot,
      allowedReadPaths: input.allowedReadPaths,
      model: input.model,
      budgetUsd: input.budgetUsd,
      homeDir: input.homeDir,
      workspaceRoot: input.workspaceRoot,
      modelClient: input.modelClient,
      debug: input.debug,
      approvalHandler: input.approvalHandler,
      onLiveEvent: input.onLiveEvent,
    }) satisfies Promise<LearningSessionResult>;

  return runCodingSession({
    task: input.task,
    contextFiles: input.contextFiles,
    browserSnapshot: input.browserSnapshot,
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
  }) satisfies Promise<CodingSessionResult>;
}
