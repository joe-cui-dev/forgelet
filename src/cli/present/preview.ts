import { loadConfig, routeModel } from "../../config/index.js";
import { modelRunnability, providerForModel } from "../../models/routing.js";
import type { LoadedBrowserSnapshot } from "../../browser/index.js";
import type { ForgeCommand } from "../parseArgs.js";

export type RunCommand = Extract<ForgeCommand, { kind: "run" }>;
export type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

export function formatSessionPreview(
  command: RunCommand,
  config: LoadedConfig,
  browserSnapshot?: LoadedBrowserSnapshot,
): string {
  const route = routeModel(config, command.workflow, command.model);
  const provider = providerForModel(route.model, config);
  const runnability = modelRunnability(route.model);
  return [
    "Session Preview",
    `Workflow: ${command.workflow}`,
    ...(command.workflowVariant
      ? [`Workflow variant: ${command.workflowVariant}`]
      : []),
    ...(command.creativeInputKind
      ? [`Creative input kind: ${command.creativeInputKind}`]
      : []),
    ...(command.creativeStyle ? [`Creative style: ${command.creativeStyle}`] : []),
    `Task: ${command.task}`,
    `Model route: ${route.model} (${route.reason})`,
    `Runnable: ${runnability.runnable ? "yes" : "no"}`,
    ...(runnability.runnable
      ? []
      : [`Runnable reason: ${runnability.previewReason}`]),
    `Required provider env var: ${provider.apiKeyEnv}`,
    `Budget: ${formatPreviewBudget(command, config)}`,
    `Action mode: ${formatPreviewActionMode(command)}`,
    `Read scope: ${formatPreviewReadScope(command)}`,
    `Context attachments: ${formatPreviewContextAttachments(command, browserSnapshot)}`,
    ...formatPreviewBrowserContext(browserSnapshot),
    `Capabilities: ${formatPreviewCapabilities(command)}`,
    "Persistence: none; no Session or Trace will be created",
  ].join("\n");
}

export function formatPreviewBudget(
  command: RunCommand,
  config: LoadedConfig,
): string {
  if (command.budgetUsd !== undefined)
    return `$${command.budgetUsd.toFixed(2)} requested`;
  return `$${config.budgets.maxEstimatedCostUsd.toFixed(2)} max estimated`;
}

export function formatPreviewActionMode(command: RunCommand): string {
  if (command.workflow === "learning") return "not available for learning";
  if (command.workflow !== "coding") return "not available for writing";
  return command.act ? "action-capable; approvals required" : "read-only";
}

export function formatPreviewReadScope(command: RunCommand): string {
  if (command.workflow === "learning") return "not available for learning";
  if (command.workflow !== "coding") return "not available for writing";
  return command.allowedReadPaths && command.allowedReadPaths.length > 0
    ? command.allowedReadPaths.join(", ")
    : "workspace default";
}

export function formatPreviewContextAttachments(
  command: RunCommand,
  browserSnapshot?: LoadedBrowserSnapshot,
): string {
  const attachments = [
    ...command.contextFiles,
    ...(browserSnapshot ? [`browser: ${browserSnapshot.title}`] : []),
    ...(command.continuationFile ? [command.continuationFile] : []),
  ];
  return attachments.length > 0 ? attachments.join(", ") : "none";
}

export function formatPreviewBrowserContext(
  browserSnapshot: LoadedBrowserSnapshot | undefined,
): string[] {
  if (!browserSnapshot) return [];
  return [
    "Browser context:",
    `URL: ${browserSnapshot.url}`,
    `Title: ${browserSnapshot.title}`,
    `Captured at: ${browserSnapshot.capturedAt}`,
    `Content: ${browserSnapshot.contentKind}`,
    `Content bytes: ${browserSnapshot.contentBytes}`,
  ];
}

export function formatPreviewCapabilities(command: RunCommand): string {
  if (command.workflow === "learning")
    return "source context, model text generation, and plan updates; no workspace, Git, patch, command, note-writing, or browser automation tools";
  if (command.workflow === "writing")
    return "model text generation and plan updates; no workspace, Git, patch, or command tools";
  if (command.act)
    return "workspace read, Git status/diff, plan updates, patch requests, configured command requests";
  return "workspace read, Git status/diff, plan updates";
}
