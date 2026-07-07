import { runCodingSession } from "../../workflows/index.js";
import {
  buildContinuationContext,
  formatContinuationHeader,
} from "../../sessions/continuation.js";
import { createDeepSeekLiveModelClient, createTerminalApprovalHandler } from "../wiring.js";
import type { ForgeCommand } from "../parseArgs.js";
import type { RunCliOptions } from "../index.js";

type ResumeCommand = Extract<ForgeCommand, { kind: "resume" }>;

export async function runResumeCommand(
  command: ResumeCommand,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string> {
  const { workspaceRoot, options } = ctx;
  const continuationContext = await buildContinuationContext(
    workspaceRoot,
    command.sessionId,
  );
  if (continuationContext.sourceWorkflow === "learning")
    throw new Error("Learning Workflow resume is not available yet.");
  if (continuationContext.sourceWorkflow !== "coding")
    throw new Error("Writing Workflow resume is not available yet.");
  const modelClient = await (
    options.createLiveModelClient ?? createDeepSeekLiveModelClient
  )({
    workflow: "coding",
    homeDir: options.homeDir,
    workspaceRoot,
    env: options.env ?? process.env,
  });
  const result = await runCodingSession({
    task: command.instruction,
    contextFiles: [],
    homeDir: options.homeDir,
    workspaceRoot,
    modelClient,
    act: command.act,
    debug: command.debug === true,
    continuationSourceSessionId: command.sessionId,
    approvalHandler: command.act
      ? options.approvalHandler ?? createTerminalApprovalHandler()
      : undefined,
    onLiveEvent: options.onLiveEvent,
  });
  return [
    formatContinuationHeader(continuationContext, result.session.id),
    "",
    result.summary,
  ].join("\n");
}
