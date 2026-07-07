import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  runCodingSession,
  runLearningSession,
  runWritingSession,
} from "../../workflows/index.js";
import { loadConfig } from "../../config/index.js";
import { loadCurrentBrowserSnapshot } from "../../browser/index.js";
import {
  loadWritingProject,
  WRITING_PROJECTS_DIR,
  type WritingProjectManifest,
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
  if (project && command.allowedReadPaths && command.allowedReadPaths.length > 0)
    throw new Error(
      "--project cannot be combined with --allow-read; the Writing Project manifest defines the Session Read Scope.",
    );
  const projectRun = project
    ? await prepareWritingProjectRun(workspaceRoot, project)
    : undefined;
  const continuationFile = resolveProjectContinuationFile({
    project,
    continuationFile: command.continuationFile,
  });
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
          ...(projectRun
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
    ...(projectRun ? projectRun.warnings : []),
    ...(projectRun && projectRun.warnings.length > 0 ? [""] : []),
    result.summary,
  ].join("\n");
}

async function prepareWritingProjectRun(
  workspaceRoot: string,
  project: WritingProjectManifest,
): Promise<{ readScopeMembers: string[]; warnings: string[] }> {
  const readScopeMembers: string[] = [];
  const warnings: string[] = [];
  for (const member of project.members) {
    if (await pathExists(join(workspaceRoot, member))) {
      readScopeMembers.push(member);
      continue;
    }
    if (member === project.head)
      throw new Error(
        `Writing Project head is missing: ${member}. Edit ${WRITING_PROJECTS_DIR}/${project.slug}.json or restore the artifact before continuing.`,
      );
    warnings.push(
      `Warning: Writing Project member is missing and was excluded from this Session Read Scope: ${member}`,
    );
  }
  return { readScopeMembers, warnings };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function resolveProjectContinuationFile(input: {
  project?: WritingProjectManifest;
  continuationFile?: string;
}): string | undefined {
  if (!input.project) return input.continuationFile;
  if (input.continuationFile) {
    if (!input.project.members.includes(input.continuationFile))
      throw new Error(
        [
          `--continue artifact is not a member of Writing Project ${input.project.slug}: ${input.continuationFile}`,
          "Remove --project to continue it directly, or edit .forgelet/writing/projects/" +
            `${input.project.slug}.json to add the member.`,
        ].join("\n"),
      );
    return input.continuationFile;
  }
  return input.project.head ?? undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
