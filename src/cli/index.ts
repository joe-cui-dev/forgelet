#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./parseArgs.js";
import type { ForgeCommand } from "./parseArgs.js";
import { helpText } from "./help.js";
import { runAgent } from "../agent/runAgent.js";
import { loadConfig, routeModel, setGlobalConfigValue } from "../config/index.js";
import { loadDotEnv } from "../config/env.js";
import { DeepSeekModelClient } from "../models/providers/deepseek.js";
import { explainSession, type SessionExplanation } from "../explain/index.js";
import { acceptMemorySuggestion, suggestMemoryFromSession } from "../memory/index.js";
import {
  loadCurrentBrowserSnapshot,
  type LoadedBrowserSnapshot,
} from "../browser/index.js";
import { installChromeNativeMessagingHost } from "../browser/nativeHostInstall.js";
import {
  createKnowledgeNote,
  searchKnowledgeNotes,
  type CreatedKnowledgeNote,
  type KnowledgeNoteSearch,
} from "../knowledge/index.js";
import { listSessions, showSession } from "../sessions/index.js";
import {
  findWritingArtifactEntry,
  readWritingArtifactCatalog,
  readWritingArtifactContent,
  type WritingArtifactCatalog,
  type WritingArtifactCatalogEntry,
} from "../writingArtifacts/index.js";
import {
  buildContinuationContext,
  formatContinuationHeader,
} from "../sessions/continuation.js";
import {
  createTerminalSessionLiveEventSink,
  type SessionLiveEvent,
  type SessionLiveEventSink,
} from "../sessionLiveView/index.js";
import type {
  MemorySuggestion,
  ModelClient,
  ModelTurnInput,
  ModelTurnOutput,
  SessionAudit,
  WorkflowKind,
} from "../types.js";
import type { ApprovalHandler, ApprovalRequest } from "../tools/toolRegistry.js";

export interface RunCliOptions {
  homeDir?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  createLiveModelClient?: (
    input: CreateLiveModelClientInput,
  ) => Promise<ModelClient>;
  approvalHandler?: ApprovalHandler;
  onLiveEvent?: SessionLiveEventSink;
}

export interface RunCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CreateLiveModelClientInput {
  workflow: WorkflowKind;
  modelOverride?: string;
  homeDir?: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface InteractiveTerminalOutputController {
  onLiveEvent: SessionLiveEventSink;
  shouldSuppressFinalStdout: (argv: string[]) => boolean;
  formatSuppressedFinalStdoutFooter: (stdout: string) => string;
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<RunCliResult> {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();

  try {
    const command = parseArgs(argv);

    switch (command.kind) {
      case "help":
        return ok(helpText());
      case "version":
        return ok("0.1.0");
      case "run": {
        const browserSnapshot = command.withBrowser
          ? await loadCurrentBrowserSnapshot({ homeDir: options.homeDir })
          : undefined;
        if (command.preview) {
          const config = await loadConfig({
            homeDir: options.homeDir,
            workspaceRoot,
          });
          return ok(formatSessionPreview(command, config, browserSnapshot));
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
        const result = await runAgent({
          workflow: command.workflow,
          workflowVariant: command.workflowVariant,
          creativeStyle: command.creativeStyle,
          creativeInputKind: command.creativeInputKind,
          task: command.task,
          contextFiles: command.contextFiles,
          browserSnapshot,
          continuationFile: command.continuationFile,
          allowedReadPaths: command.allowedReadPaths,
          model: command.model,
          budgetUsd: command.budgetUsd,
          homeDir: options.homeDir,
          workspaceRoot,
          modelClient,
          act: command.act,
          approvalHandler: command.act
            ? options.approvalHandler ?? createTerminalApprovalHandler()
            : undefined,
          onLiveEvent: options.onLiveEvent,
        });
        return ok(
          [
            ...formatPreviewBrowserContext(browserSnapshot),
            ...(browserSnapshot ? [""] : []),
            result.summary,
          ].join("\n"),
        );
      }
      case "resume": {
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
        const result = await runAgent({
          workflow: "coding",
          task: command.instruction,
          contextFiles: [],
          homeDir: options.homeDir,
          workspaceRoot,
          modelClient,
          act: command.act,
          continuationSourceSessionId: command.sessionId,
          approvalHandler: command.act
            ? options.approvalHandler ?? createTerminalApprovalHandler()
            : undefined,
          onLiveEvent: options.onLiveEvent,
        });
        return ok(
          [
            formatContinuationHeader(continuationContext, result.session.id),
            "",
            result.summary,
          ].join("\n"),
        );
      }
      case "config-get":
        return ok(JSON.stringify(await loadConfig({ homeDir: options.homeDir, workspaceRoot }), null, 2));
      case "config-set":
        await setGlobalConfigValue({
          homeDir: options.homeDir,
          key: command.key,
          value: command.value,
        });
        return ok(`Config set: ${command.key}=${command.value}`);
      case "sessions-list":
        return ok(formatSessionList(await listSessions(workspaceRoot)));
      case "sessions-show":
        return ok(formatSessionDetail(await showSession(workspaceRoot, command.sessionId)));
      case "explain":
        return ok(formatSessionExplanation(await explainSession(workspaceRoot, command.sessionId)));
      case "notes-create":
        return ok(
          formatCreatedKnowledgeNote(
            await createKnowledgeNote(workspaceRoot, {
              scope: command.scope,
              fromSessionId: command.fromSessionId,
              title: command.title,
            }),
          ),
        );
      case "notes-search":
        return ok(
          formatKnowledgeNoteSearch(
            await searchKnowledgeNotes(workspaceRoot, {
              scope: command.scope,
              query: command.query,
              limit: command.limit,
            }),
          ),
        );
      case "writing-artifacts-list":
        return ok(formatWritingArtifactCatalog(await readWritingArtifactCatalog(workspaceRoot)));
      case "writing-artifacts-show": {
        const entry = await findWritingArtifactEntry({
          workspaceRoot,
          artifact: command.artifact,
        });
        if (entry.status === "missing")
          throw new Error(
            `Writing artifact file is missing: ${entry.path}. Trace provenance still exists at ${entry.tracePath ?? "unknown"}.`,
          );
        return ok(
          formatWritingArtifactDetail({
            entry,
            ...(await readWritingArtifactContent({
              workspaceRoot,
              entry,
              full: command.full,
            })),
          }),
        );
      }
      case "memory-suggest":
        return ok(formatMemorySuggestion(await suggestMemoryFromSession(workspaceRoot, command.sessionId)));
      case "memory-accept":
        return ok(formatAcceptedMemory(await acceptMemorySuggestion(workspaceRoot, command.suggestionId)));
      case "browser-read-current":
        return ok(
          formatBrowserSnapshot(
            await loadCurrentBrowserSnapshot({ homeDir: options.homeDir }),
          ),
        );
      case "browser-install-host":
        return ok(
          formatInstalledChromeNativeHost(
            await installChromeNativeMessagingHost({
              extensionId: command.extensionId,
              homeDir: options.homeDir ?? process.env.HOME ?? "",
              workspaceRoot,
            }),
          ),
        );
      default: {
        const exhaustive: never = command;
        throw new Error(`Unhandled command: ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { stdout: "", stderr: `forge: ${message}`, exitCode: 1 };
  }
}

function formatInstalledChromeNativeHost(input: {
  manifestPath: string;
  hostPath: string;
  extensionId: string;
}): string {
  return [
    "Chrome Native Messaging host installed",
    `Extension id: ${input.extensionId}`,
    `Manifest: ${input.manifestPath}`,
    `Host: ${input.hostPath}`,
  ].join("\n");
}

function formatWritingArtifactCatalog(catalog: WritingArtifactCatalog): string {
  const untracked = catalog.entries.filter(
    (entry) => entry.status === "untracked",
  ).length;
  if (catalog.entries.length === 0)
    return [
      "Writing Artifact Catalog",
      `Path: ${catalog.path}`,
      "Artifacts: 0",
      "Untracked: 0",
    ].join("\n");
  return [
    "Writing Artifact Catalog",
    `Path: ${catalog.path}`,
    `Artifacts: ${catalog.entries.length}`,
    `Untracked: ${untracked}`,
    "",
    ...catalog.entries.flatMap((entry, index) => [
      `${index + 1}. ${entry.path.replace(/^\.forgelet\/writing\//, "")}`,
      `   Status: ${entry.status}`,
      `   Kind: ${entry.contentKind}`,
      `   Session: ${entry.sessionId ?? "none"}`,
      `   Created: ${entry.createdAt}`,
      ...(entry.task ? [`   Task: ${entry.task}`] : []),
      `   Bytes: ${entry.contentBytes}`,
      `   Continue: ${formatWritingArtifactContinueHint(entry)}`,
      "",
    ]),
  ].join("\n").trimEnd();
}

function formatWritingArtifactContinueHint(
  entry: WritingArtifactCatalogEntry,
): string {
  if (entry.status === "missing")
    return "unavailable; artifact file is missing";
  const style = entry.creativeStyle ?? "<style>";
  return `forge write --creative --style ${style} --continue ${entry.path} "<brief>"`;
}

function formatWritingArtifactDetail(input: {
  entry: WritingArtifactCatalogEntry;
  body: string;
  truncated: boolean;
}): string {
  const entry = input.entry;
  return [
    "Writing Artifact",
    `Path: ${entry.path}`,
    `Status: ${entry.status}`,
    `Kind: ${entry.contentKind}`,
    `Session: ${entry.sessionId ?? "none"}`,
    `Created: ${entry.createdAt}`,
    ...(entry.task ? [`Task: ${entry.task}`] : []),
    `Bytes: ${entry.contentBytes}`,
    `Trace: ${entry.tracePath ?? "none"}`,
    `Continue: ${formatWritingArtifactContinueHint(entry)}`,
    "",
    "Preview:",
    input.body,
    ...(input.truncated ? ["[truncated]"] : []),
  ].join("\n");
}

function formatBrowserSnapshot(snapshot: LoadedBrowserSnapshot): string {
  return [
    "Browser Context Snapshot",
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Captured at: ${snapshot.capturedAt}`,
    `Content: ${snapshot.contentKind}`,
    `Content bytes: ${snapshot.contentBytes}`,
    `Content hash: ${snapshot.contentHash}`,
    `Preview: ${snapshot.preview}`,
    ...(snapshot.screenshotPath ? [`Screenshot path: ${snapshot.screenshotPath}`] : []),
  ].join("\n");
}

function createTerminalApprovalHandler(): ApprovalHandler {
  return async (request) => {
    const prompt = formatApprovalPrompt(request);
    const readline = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      let answer = await readline.question(`${prompt}\nApprove? [y/N${request.toolCall.name === "apply_patch" ? "/s" : ""}] `);
      if (request.toolCall.name === "apply_patch" && answer.toLowerCase() === "s") {
        const patch = isRecord(request.toolCall.input) && typeof request.toolCall.input.patch === "string"
          ? request.toolCall.input.patch
          : "";
        if (patch) process.stderr.write(`\n${patch}\n`);
        answer = await readline.question("Approve? [y/N] ");
        return {
          status: answer.toLowerCase() === "y" ? "approved" : "rejected",
          reason: answer.toLowerCase() === "y" ? "Approved by user." : "Rejected by user.",
          fullPatchShown: true,
        };
      }
      return {
        status: answer.toLowerCase() === "y" ? "approved" : "rejected",
        reason: answer.toLowerCase() === "y" ? "Approved by user." : "Rejected by user.",
        fullPatchShown: false,
      };
    } finally {
      readline.close();
    }
  };
}

function formatApprovalPrompt(request: ApprovalRequest): string {
  if (request.toolCall.name === "run_command") {
    const command = isRecord(request.toolCall.input) && typeof request.toolCall.input.command === "string"
      ? request.toolCall.input.command
      : "(unknown command)";
    return [
      "Forgelet requests approval to run a configured command.",
      `Command: ${command}`,
      `Workspace: ${request.toolRequest.workspaceRoot}`,
      `Reason: ${request.permissionDecision.reason}`,
    ].join("\n");
  }
  if (request.toolCall.name === "apply_patch") {
    const patch = isRecord(request.toolCall.input) && typeof request.toolCall.input.patch === "string"
      ? request.toolCall.input.patch
      : "";
    const hash = patch ? hashText(patch) : "(unknown)";
    const files = request.toolRequest.targets
      ?.filter((target) => target.kind === "path")
      .map((target) => target.path)
      .join(", ") || "(unknown)";
    return [
      "Forgelet requests approval to apply a patch.",
      `Changed files: ${files}`,
      `Patch hash: ${hash}`,
      `Preview:\n${patch.slice(0, 1_000)}`,
      `Reason: ${request.permissionDecision.reason}`,
      "Enter s to show the full patch before deciding.",
    ].join("\n");
  }
  return [
    `Forgelet requests approval for ${request.toolCall.name}.`,
    `Reason: ${request.permissionDecision.reason}`,
  ].join("\n");
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

async function createDeepSeekLiveModelClient(
  input: CreateLiveModelClientInput,
): Promise<ModelClient> {
  await loadDotEnv({ workspaceRoot: input.workspaceRoot, env: input.env });
  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const route = routeModel(config, input.workflow, input.modelOverride);
  if (!route.model.startsWith("deepseek-")) {
    throw new Error(
      `Model-backed execution currently supports DeepSeek models only. Route selected ${route.model}.`,
    );
  }
  const apiKeyEnv = config.providers.deepseek.apiKeyEnv;
  const apiKey = input.env[apiKeyEnv];
  if (!apiKey)
    throw new Error(
      `${apiKeyEnv} is required for model-backed Sessions. Set it in .env, or run forge code --preview "<task>" to inspect routing without calling a model.`,
    );
  return new DeepSeekModelClient({ apiKey, model: route.model });
}

function ok(stdout: string): RunCliResult {
  return { stdout, stderr: "", exitCode: 0 };
}

type RunCommand = Extract<ForgeCommand, { kind: "run" }>;
type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

function formatSessionPreview(
  command: RunCommand,
  config: LoadedConfig,
  browserSnapshot?: LoadedBrowserSnapshot,
): string {
  const route = routeModel(config, command.workflow, command.model);
  const provider = providerForModel(route.model, config);
  const runnable = route.model.startsWith("deepseek-");
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
    `Runnable: ${runnable ? "yes" : "no"}`,
    ...(runnable
      ? []
      : [
          `Runnable reason: model-backed execution currently supports DeepSeek routes only; ${route.model} is not runnable.`,
        ]),
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

function providerForModel(
  model: string,
  config: LoadedConfig,
): { name: string; apiKeyEnv: string } {
  if (model.startsWith("deepseek-")) {
    return { name: "deepseek", apiKeyEnv: config.providers.deepseek.apiKeyEnv };
  }
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  ) {
    return { name: "openai", apiKeyEnv: config.providers.openai.apiKeyEnv };
  }
  if (model.startsWith("claude-")) {
    return {
      name: "anthropic",
      apiKeyEnv: config.providers.anthropic.apiKeyEnv,
    };
  }
  return { name: "unknown", apiKeyEnv: "unknown" };
}

function createDeferredLiveModelClient(
  input: CreateLiveModelClientInput,
  factory: (input: CreateLiveModelClientInput) => Promise<ModelClient>,
): ModelClient {
  let clientPromise: Promise<ModelClient> | undefined;
  return {
    createTurn: async (
      turnInput: ModelTurnInput,
    ): Promise<ModelTurnOutput> => {
      clientPromise ??= factory(input);
      const client = await clientPromise;
      return client.createTurn(turnInput);
    },
  };
}

function formatPreviewBudget(
  command: RunCommand,
  config: LoadedConfig,
): string {
  if (command.budgetUsd !== undefined)
    return `$${command.budgetUsd.toFixed(2)} requested`;
  return `$${config.budgets.maxEstimatedCostUsd.toFixed(2)} max estimated`;
}

function formatPreviewActionMode(command: RunCommand): string {
  if (command.workflow === "learning") return "not available for learning";
  if (command.workflow !== "coding") return "not available for writing";
  return command.act ? "action-capable; approvals required" : "read-only";
}

function formatPreviewReadScope(command: RunCommand): string {
  if (command.workflow === "learning") return "not available for learning";
  if (command.workflow !== "coding") return "not available for writing";
  return command.allowedReadPaths && command.allowedReadPaths.length > 0
    ? command.allowedReadPaths.join(", ")
    : "workspace default";
}

function formatPreviewContextAttachments(
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

function formatPreviewBrowserContext(
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

function formatPreviewCapabilities(command: RunCommand): string {
  if (command.workflow === "learning")
    return "source context, model text generation, and plan updates; no workspace, Git, patch, command, note-writing, or browser automation tools";
  if (command.workflow === "writing")
    return "model text generation and plan updates; no workspace, Git, patch, or command tools";
  if (command.act)
    return "workspace read, Git status/diff, plan updates, patch requests, configured command requests";
  return "workspace read, Git status/diff, plan updates";
}

function formatSessionList(sessions: Awaited<ReturnType<typeof listSessions>>): string {
  if (sessions.length === 0) return "No Forgelet sessions found.";
  return sessions.map((session) => `${session.id}\t${session.workflow}\t${session.status}\t${session.startedAt}\t${session.taskHash || "none"}\t${session.task}`).join("\n");
}

function formatSessionDetail(session: Awaited<ReturnType<typeof showSession>>): string {
  const context = session.contextAttachments.length > 0 ? session.contextAttachments.map((attachment) => attachment.title ?? attachment.id).join(", ") : "none";
  const route = session.route ? `${session.route.model} (${session.route.reason})` : "none";
  return [
    `Session: ${session.id}`,
    `Status: ${session.status}`,
    `Workflow: ${session.workflow}`,
    `Task: ${session.task}`,
    `Task hash: ${session.taskHash || "none"}`,
    `Started: ${session.startedAt}`,
    `Context attachments: ${context}`,
    `Route: ${route}`,
    `Final summary: ${session.finalSummary}`,
    ...formatSessionAuditHighlights(session.audit),
    `Trace: ${session.tracePath}`
  ].join("\n");
}

function formatSessionAuditHighlights(audit: SessionAudit | undefined): string[] {
  if (!audit) return [];
  return [
    "Audit:",
    ...(audit.changeGroups.inheritedForgeletChanged &&
    audit.changeGroups.inheritedForgeletChanged.length > 0
      ? [
          `Inherited Forgelet changes: ${formatList(
            audit.changeGroups.inheritedForgeletChanged,
          )}`,
        ]
      : []),
    `Forgelet changed: ${formatList(audit.changeGroups.forgeletChanged)}`,
    `Pre-existing at Session start: ${formatList(audit.changeGroups.preExistingAtSessionStart)}`,
    `Other current workspace changes: ${formatList(audit.changeGroups.otherCurrentWorkspaceChanges)}`,
    audit.verificationCommands.length > 0
      ? "Verification commands:"
      : "Verification commands: none",
    ...audit.verificationCommands.map(
      (command) =>
        `- ${command.command} (${command.timedOut ? "timed out" : `exit ${command.exitCode}`})`,
    ),
    audit.kernelObservedRisks.length > 0
      ? "Kernel-observed risks:"
      : "Kernel-observed risks: none",
    ...audit.kernelObservedRisks.map((risk) => `- ${risk.message}`),
  ];
}

function formatSessionExplanation(explanation: SessionExplanation): string {
  return [
    `Session explanation: ${explanation.sessionId}`,
    "",
    "What happened",
    `Status: ${explanation.status}`,
    `Workflow: ${explanation.workflow}`,
    `Task: ${explanation.task || "none"}`,
    explanation.route
      ? `Route: ${explanation.route.model} (${explanation.route.reason})`
      : "Route: none",
    `Model turns: ${explanation.modelTurns}`,
    ...formatEstimatedCost(explanation.audit),
    ...formatMissingEvidence(explanation.missingEvidence),
    "",
    "Tool use",
    ...formatToolResults(explanation.toolResults),
    ...formatConversationCompaction(explanation.compaction),
    "",
    "Permissions and approvals",
    ...formatPermissions(explanation),
    "",
    "Verification and risks",
    ...formatExplanationAudit(explanation.audit),
    "",
    "Agent Kernel takeaways",
    "- Trace records the model turns, tool calls, permission decisions, results, and final audit.",
    "- The explanation is deterministic: it only uses recorded Session evidence.",
  ].join("\n");
}

function formatConversationCompaction(
  compaction: SessionExplanation["compaction"],
): string[] {
  if (!compaction) return [];
  return [
    "",
    "Conversation compaction:",
    `Passes: ${compaction.passCount}`,
    `Compacted observations: ${compaction.compactedObservations}`,
    `Bytes removed: ${compaction.bytesRemoved}`,
    `Maximum residual overage: ${compaction.maxResidualOverageBytes} bytes`,
  ];
}

function formatCreatedKnowledgeNote(note: CreatedKnowledgeNote): string {
  return [
    "Knowledge Note created",
    `Path: ${note.path}`,
    `Source Session: ${note.sourceSessionId}`,
    `Sources: ${note.sourceCount}`,
    `Content hash: ${note.contentHash}`,
  ].join("\n");
}

function formatKnowledgeNoteSearch(search: KnowledgeNoteSearch): string {
  return [
    "Knowledge Notes Search",
    `Scope: ${search.scope}`,
    `Path: ${search.path}`,
    `Query: ${search.query}`,
    `Results: ${search.results.length}`,
    ...search.results.flatMap((result, index) => [
      "",
      `${index + 1}. ${result.title}`,
      `   Path: ${result.path}`,
      `   Source Session: ${result.sourceSessionId}`,
      `   Snippet: ${result.snippet}`,
    ]),
  ].join("\n");
}

function formatMemorySuggestion(suggestion: MemorySuggestion): string {
  return [
    `Memory suggestion: ${suggestion.id}`,
    `Source Session: ${suggestion.sourceSessionId}`,
    `Status: ${suggestion.status}`,
    `Reason: ${suggestion.reason}`,
    suggestion.text,
  ].join("\n");
}

function formatAcceptedMemory(suggestion: MemorySuggestion): string {
  return [
    `Memory accepted: ${suggestion.id}`,
    `Source Session: ${suggestion.sourceSessionId}`,
  ].join("\n");
}

function formatMissingEvidence(missingEvidence: string[]): string[] {
  return missingEvidence.length > 0
    ? [`Missing evidence: ${missingEvidence.join(", ")}`]
    : [];
}

function formatEstimatedCost(audit: SessionAudit | undefined): string[] {
  return audit ? [`Estimated cost: $${audit.estimatedCostUsd.toFixed(4)}`] : [];
}

function formatToolResults(
  toolResults: SessionExplanation["toolResults"],
): string[] {
  if (toolResults.length === 0) return ["- none"];
  return toolResults.map(
    (tool) =>
      `- ${tool.toolName}: ${tool.summary || (tool.ok ? "ok" : "failed")}`,
  );
}

function formatPermissions(explanation: SessionExplanation): string[] {
  const lines = explanation.permissionDecisions.map(
    (decision) =>
      `- ${decision.toolName} requested ${decision.capability} at ${decision.riskTier} risk: ${decision.decision}`,
  );
  lines.push(
    ...explanation.approvalDecisions.map(
      (approval) => `- ${approval.toolName} approval: ${approval.status}`,
    ),
  );
  return lines.length > 0 ? lines : ["- none"];
}

function formatExplanationAudit(audit: SessionAudit | undefined): string[] {
  if (!audit) return ["No final audit was recorded."];
  return [
    ...(audit.changeGroups.inheritedForgeletChanged &&
    audit.changeGroups.inheritedForgeletChanged.length > 0
      ? [
          `Inherited Forgelet changes: ${formatList(
            audit.changeGroups.inheritedForgeletChanged,
          )}`,
        ]
      : []),
    `Forgelet changed: ${formatList(audit.changeGroups.forgeletChanged)}`,
    audit.verificationCommands.length > 0
      ? "Verification commands:"
      : "Verification commands: none",
    ...audit.verificationCommands.map(
      (command) =>
        `- ${command.command} (${command.timedOut ? "timed out" : `exit ${command.exitCode}`})`,
    ),
    audit.kernelObservedRisks.length > 0
      ? "Kernel-observed risks:"
      : "Kernel-observed risks: none",
    ...audit.kernelObservedRisks.map((risk) => `- ${risk.message}`),
  ];
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

export function createInteractiveTerminalOutputController(
  write: (text: string) => void,
): InteractiveTerminalOutputController {
  const terminalLiveView = createTerminalSessionLiveEventSink(write);
  const turnsWithStreamedOutput = new Set<number>();
  let finalAnswerStreamed = false;

  return {
    onLiveEvent: async (event) => {
      observeStreamedFinalAnswer(event, turnsWithStreamedOutput, (streamed) => {
        finalAnswerStreamed = streamed;
      });
      await terminalLiveView(event);
    },
    shouldSuppressFinalStdout: (argv) =>
      finalAnswerStreamed && isInteractiveWritingRun(argv),
    formatSuppressedFinalStdoutFooter,
  };
}

function observeStreamedFinalAnswer(
  event: SessionLiveEvent,
  turnsWithStreamedOutput: Set<number>,
  setFinalAnswerStreamed: (streamed: boolean) => void,
): void {
  if (event.type === "model_output_delta" && event.text.length > 0) {
    turnsWithStreamedOutput.add(event.turnIndex);
    return;
  }

  if (
    event.type === "model_turn_finished" &&
    event.toolCallCount === 0 &&
    turnsWithStreamedOutput.has(event.turnIndex)
  ) {
    setFinalAnswerStreamed(true);
  }
}

function isInteractiveWritingRun(argv: string[]): boolean {
  try {
    const command = parseArgs(argv);
    return (
      command.kind === "run" &&
      command.workflow === "writing" &&
      !command.preview
    );
  } catch {
    return false;
  }
}

function formatSuppressedFinalStdoutFooter(stdout: string): string {
  return stdout
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("Writing artifact: ") || line.startsWith("Trace: "),
    )
    .join("\n");
}

async function main(): Promise<void> {
  const terminalOutput =
    process.stdout.isTTY && process.stderr.isTTY
      ? createInteractiveTerminalOutputController((line) =>
          process.stderr.write(line),
        )
      : undefined;
  const argv = process.argv.slice(2);
  const result = await runCli(argv, {
    onLiveEvent: terminalOutput?.onLiveEvent,
  });
  if (result.stdout) {
    if (terminalOutput?.shouldSuppressFinalStdout(argv)) {
      const footer = terminalOutput.formatSuppressedFinalStdoutFooter(
        result.stdout,
      );
      if (footer) process.stderr.write(`${footer}\n`);
    } else {
      console.log(result.stdout);
    }
  }
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
}

export function isCliEntrypoint(
  argvPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return argvPath === fileURLToPath(moduleUrl);
  }
}

if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  await main();
}
