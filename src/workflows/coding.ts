import { loadContextAttachments } from "../context/index.js";
import { resumeKernelSession, runKernelSession } from "../kernel/session.js";
import { kernelCommonPromptLines } from "../kernel/messages.js";
import type {
  KernelSessionResult,
  RunKernelSessionInput,
  WorkflowDefinition,
} from "../kernel/workflowDefinition.js";
import type {
  ResumeDecision,
  ResumeKernelSessionInput,
} from "../kernel/session.js";
import { createActionableCodingTools } from "../tools/actionable.js";

export type CodingSessionInput = Omit<
  RunKernelSessionInput,
  "definition" | "readScopeRequest"
> & {
  allowedReadPaths?: string[];
};

export type CodingSessionResult = KernelSessionResult;

export function runCodingSession(
  input: CodingSessionInput,
): Promise<CodingSessionResult> {
  return runKernelSession({
    task: input.task,
    contextFiles: input.contextFiles,
    browserSnapshot: input.browserSnapshot,
    publicWeb: input.publicWeb,
    model: input.model,
    budgetUsd: input.budgetUsd,
    maxWallClockMs: input.maxWallClockMs,
    maxModelTurns: input.maxModelTurns,
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
    modelClient: input.modelClient,
    act: input.act,
    debug: input.debug,
    continuationSourceSessionId: input.continuationSourceSessionId,
    approvalHandler: input.approvalHandler,
    envelope: input.envelope,
    now: input.now,
    onLiveEvent: input.onLiveEvent,
    signal: input.signal,
    readScopeRequest: input.allowedReadPaths,
    definition: createCodingWorkflowDefinition(),
  });
}

export type ResumeCodingSessionInput = Omit<
  ResumeKernelSessionInput,
  "definition"
>;

export function resumeCodingSession(
  input: ResumeCodingSessionInput,
): Promise<CodingSessionResult> {
  return resumeKernelSession({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    modelClient: input.modelClient,
    decision: input.decision,
    homeDir: input.homeDir,
    now: input.now,
    onLiveEvent: input.onLiveEvent,
    definition: createCodingWorkflowDefinition(),
  });
}

export type { ResumeDecision };

export function createCodingWorkflowDefinition(): WorkflowDefinition {
  return {
    kind: "coding",
    async loadAttachments({ workspaceRoot, contextFiles, sourceLedger }) {
      return {
        contextAttachments: await loadContextAttachments(
          workspaceRoot,
          contextFiles,
          { sourceLedger },
        ),
      };
    },
    capabilities({ act }) {
      return [
        "read_context",
        "read_workspace",
        "git_read",
        "update_plan",
        "model_generate_text",
        ...(act ? (["write_workspace", "run_safe_command"] as const) : []),
      ];
    },
    createActionableTools(deps) {
      return createActionableCodingTools(deps);
    },
    systemPrompt({ act }) {
      const codingWorkspaceSummaryGuidance = [
        "When you need an overview of an unfamiliar workspace, call workspace_summary first.",
        "Follow up with targeted search_text, read_file, git_status, or git_diff only when specific evidence is needed.",
        "workspace_summary is an on-demand tool result; do not assume it was automatically injected.",
      ];
      if (act)
        return [
          ...kernelCommonPromptLines(),
          "This is an actionable Coding Workflow Session.",
          ...codingWorkspaceSummaryGuidance,
          "You may request apply_patch and run_command only when those tools are provided.",
          "Every file edit or command must pass Forgelet permission and approval boundaries before it runs.",
          "Do not claim verification succeeded unless a run_command observation shows the command ran successfully.",
        ].join("\n");
      return [
        ...kernelCommonPromptLines(),
        "This is a read-only Coding Workflow Session.",
        "Read-only tools may inspect workspace content; do not claim to write files or run commands.",
        ...codingWorkspaceSummaryGuidance,
        "When you need to locate specific code — a symbol, a function, or where a described behavior is implemented — and the file is not named or obvious, find it with search_text before opening files with read_file; if the user named the file or the path is obvious, read it directly.",
        "Do not speculatively open multiple files in parallel before their relevance is confirmed; once search or references confirm which files matter, you may read them in parallel.",
      ].join("\n");
    },
  };
}
