import { loadContextAttachments } from "../context/index.js";
import { runKernelSession } from "../kernel/session.js";
import { kernelCommonPromptLines } from "../kernel/messages.js";
import type {
  KernelSessionResult,
  RunKernelSessionInput,
  WorkflowDefinition,
} from "../kernel/workflowDefinition.js";
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
    ...input,
    readScopeRequest: input.allowedReadPaths,
    definition: createCodingWorkflowDefinition(),
  });
}

export function createCodingWorkflowDefinition(): WorkflowDefinition {
  return {
    kind: "coding",
    async loadAttachments({ workspaceRoot, contextFiles }) {
      return {
        contextAttachments: await loadContextAttachments(
          workspaceRoot,
          contextFiles,
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
    systemPrompt({ act, finalOnly }) {
      const codingWorkspaceSummaryGuidance = [
        "When you need an overview of an unfamiliar workspace, call workspace_summary first.",
        "Follow up with targeted search_text, read_file, git_status, or git_diff only when specific evidence is needed.",
        "workspace_summary is an on-demand tool result; do not assume it was automatically injected.",
      ];
      if (act)
        return [
          ...kernelCommonPromptLines(finalOnly),
          "This is an actionable Coding Workflow Session.",
          ...codingWorkspaceSummaryGuidance,
          "You may request apply_patch and run_command only when those tools are provided.",
          "Every file edit or command must pass Forgelet permission and approval boundaries before it runs.",
          "Do not claim verification succeeded unless a run_command observation shows the command ran successfully.",
        ].join("\n");
      return [
        ...kernelCommonPromptLines(finalOnly),
        "This is a read-only Coding Workflow Session.",
        "Read-only tools may inspect workspace content; do not claim to write files or run commands.",
        ...codingWorkspaceSummaryGuidance,
      ].join("\n");
    },
  };
}
