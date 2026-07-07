import {
  runCodingSession,
  runLearningSession,
  runWritingSession,
} from "../../workflows/index.js";
import { loadConfig } from "../../config/index.js";
import { loadCurrentBrowserSnapshot } from "../../browser/index.js";
import {
  loadWritingProject,
  prepareWritingProjectRun,
} from "../../writingProjects/index.js";
import {
  formatPreviewBrowserContext,
  formatSessionPreview,
  type RunCommand,
} from "../present/preview.js";
import {
  createDeepSeekLiveModelClient,
  createDeferredLiveModelClient,
  createTerminalApprovalHandler,
} from "../wiring.js";
import type { RunCliOptions } from "../index.js";

export async function runRunCommand(
  command: RunCommand,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string> {
  const { workspaceRoot, options } = ctx;
  const project = command.projectSlug
    ? await loadWritingProject(workspaceRoot, command.projectSlug)
    : undefined;
  const projectRun = await prepareWritingProjectRun({
    workspaceRoot,
    project,
    continuationFile: command.continuationFile,
    allowedReadPaths: command.allowedReadPaths,
  });
  const continuationFile = projectRun.continuationFile;
  const browserSnapshot = command.withBrowser
    ? await loadCurrentBrowserSnapshot({ homeDir: options.homeDir })
    : undefined;
  if (command.preview) {
    const config = await loadConfig({
      homeDir: options.homeDir,
      workspaceRoot,
    });
    return formatSessionPreview(command, config, browserSnapshot);
  }
  const modelClient = createDeferredLiveModelClient(
    {
      workflow: command.workflow,
      modelOverride: command.model,
      homeDir: options.homeDir,
      workspaceRoot,
      env: options.env ?? process.env,
    },
    options.createLiveModelClient ?? createDeepSeekLiveModelClient,
  );
  const result =
    command.workflow === "writing"
      ? await runWritingSession({
          workflowVariant: command.workflowVariant,
          creativeStyle: command.creativeStyle,
          creativeInputKind: command.creativeInputKind,
          task: command.task,
          contextFiles: command.contextFiles,
          browserSnapshot,
          continuationFile,
          ...(project ? { project } : {}),
          ...(project
            ? { projectReadScopeMembers: projectRun.readScopeMembers }
            : {}),
          allowedReadPaths: command.allowedReadPaths,
          model: command.model,
          budgetUsd: command.budgetUsd,
          homeDir: options.homeDir,
          workspaceRoot,
          modelClient,
          debug: command.debug === true,
          onLiveEvent: options.onLiveEvent,
        })
      : command.workflow === "learning"
        ? await runLearningSession({
            task: command.task,
            contextFiles: command.contextFiles,
            browserSnapshot,
            allowedReadPaths: command.allowedReadPaths,
            model: command.model,
            budgetUsd: command.budgetUsd,
            homeDir: options.homeDir,
            workspaceRoot,
            modelClient,
            debug: command.debug === true,
            onLiveEvent: options.onLiveEvent,
          })
        : await runCodingSession({
            task: command.task,
            contextFiles: command.contextFiles,
            browserSnapshot,
            allowedReadPaths: command.allowedReadPaths,
            model: command.model,
            budgetUsd: command.budgetUsd,
            homeDir: options.homeDir,
            workspaceRoot,
            modelClient,
            act: command.act,
            debug: command.debug === true,
            approvalHandler: command.act
              ? options.approvalHandler ?? createTerminalApprovalHandler()
              : undefined,
            onLiveEvent: options.onLiveEvent,
          });
  return [
    ...formatPreviewBrowserContext(browserSnapshot),
    ...(browserSnapshot ? [""] : []),
    ...projectRun.warnings,
    ...(projectRun.warnings.length > 0 ? [""] : []),
    result.summary,
  ].join("\n");
}
