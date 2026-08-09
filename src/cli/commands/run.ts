import {
  runCodingSession,
  runWritingSession,
} from "../../workflows/index.js";
import { launchLearningSession } from "../../sessionLauncher/index.js";
import { loadConfig } from "../../config/index.js";
import { loadCurrentBrowserSnapshot } from "../../browser/index.js";
import type { EffectEnvelope } from "../../permissions/envelope.js";
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
  createCliPublicWebAdapters,
  createDeferredLiveModelClient,
  createTerminalApprovalHandler,
} from "../wiring.js";
import {
  captureMemorySuggestions,
  readSessionFriction,
} from "../../memory/index.js";
import {
  formatMemoryCapture,
  formatNonInteractiveCaptureHint,
  formatSessionFriction,
} from "../present/memory.js";
import type { RunCliOptions } from "../index.js";

export function formatEffectEnvelopeBanner(envelope: EffectEnvelope): string {
  return [
    "Effect Envelope declared:",
    `  Write scope: ${envelope.writeScopePrefixes.join(", ") || "(none)"}`,
    `  Allowed commands: ${envelope.allowedCommands.join(", ") || "(none)"}`,
    "Actions outside this envelope will pause the Session for `forge decide`.",
  ].join("\n");
}

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
  const publicWeb = command.publicWeb
    ? await createCliPublicWebAdapters({
        workspaceRoot,
        homeDir: options.homeDir,
        env: options.env ?? process.env,
      })
    : undefined;
  const modelClient = createDeferredLiveModelClient(
    {
      workflow: command.workflow,
      modelOverride: command.model,
      effortOverride: command.effort,
      homeDir: options.homeDir,
      workspaceRoot,
      env: options.env ?? process.env,
    },
    options.createLiveModelClient ?? createDeepSeekLiveModelClient,
  );
  const envelope: EffectEnvelope | undefined =
    command.workflow === "coding" && command.writeScopePrefixes
      ? {
          writeScopePrefixes: command.writeScopePrefixes,
          allowedCommands:
            command.allowedCommands ??
            (
              await loadConfig({ homeDir: options.homeDir, workspaceRoot })
            ).safeCommands,
        }
      : undefined;
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
          effort: command.effort,
          budgetUsd: command.budgetUsd,
          homeDir: options.homeDir,
          workspaceRoot,
          modelClient,
          debug: command.debug === true,
          onLiveEvent: options.onLiveEvent,
        })
      : command.workflow === "learning"
        ? await launchLearningSession({
            task: command.task,
            contextFiles: command.contextFiles,
            browserSnapshot,
            ...(publicWeb ? { publicWeb } : {}),
            allowedReadPaths: command.allowedReadPaths,
            model: command.model,
            effort: command.effort,
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
            effort: command.effort,
            budgetUsd: command.budgetUsd,
            maxWallClockMs: command.maxWallClockMs,
            maxModelTurns: command.maxModelTurns,
            homeDir: options.homeDir,
            workspaceRoot,
            modelClient,
            act: command.act,
            debug: command.debug === true,
            envelope,
            approvalHandler:
              command.act && !envelope
                ? options.approvalHandler ?? createTerminalApprovalHandler()
                : undefined,
            onLiveEvent: options.onLiveEvent,
          });
  const captureTail = await runSessionMemoryCapture(result.session.id, ctx);
  return [
    ...(envelope ? [formatEffectEnvelopeBanner(envelope), ""] : []),
    ...formatPreviewBrowserContext(browserSnapshot),
    ...(browserSnapshot ? [""] : []),
    ...projectRun.warnings,
    ...(projectRun.warnings.length > 0 ? [""] : []),
    result.summary,
    ...(captureTail ? ["", captureTail] : []),
  ].join("\n");
}

/** The Session-end Durable Memory capture step (ADR 0076). Fires only after the
 * Session's Trace is flushed and closed, and only when it carried a Friction
 * Signal. At an interactive terminal it prompts for a Memory line and records
 * what the user writes; without one it prints the friction so the user can
 * backfill later with `forge memory add`. Returns the tail to append to the
 * Session output, or undefined when there is nothing to say. */
async function runSessionMemoryCapture(
  sessionId: string,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string | undefined> {
  const { workspaceRoot, options } = ctx;
  const config = await loadConfig({ homeDir: options.homeDir, workspaceRoot });
  if (!config.memoryCapturePrompt) return undefined;

  let signals;
  try {
    ({ signals } = await readSessionFriction(workspaceRoot, sessionId));
  } catch {
    // A Session whose Trace cannot be read or folded has no friction to capture.
    return undefined;
  }
  if (signals.length === 0) return undefined;

  if (!options.capturePrompt) {
    return formatNonInteractiveCaptureHint(sessionId, signals);
  }

  const lines = await options.capturePrompt({
    sessionId,
    frictionLines: formatSessionFriction(signals),
  });
  const captured = await captureMemorySuggestions(workspaceRoot, sessionId, lines);
  if (captured.length === 0) return undefined;
  return formatMemoryCapture(sessionId, captured);
}
