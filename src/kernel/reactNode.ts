import type {
  AgentPlan,
  AgentSession,
  BudgetLimits,
  BudgetUsage,
  Capability,
  LoadedContextAttachment,
  ModelClient,
  ModelMessage,
  ModelToolCall,
  ModelTurnOutput,
  SessionAudit,
  SessionFinishStatus,
  SessionStopReason,
  ToolObservation,
  WorkflowKind,
} from "../types.js";
import { execFile } from "node:child_process";
import { compactConversationInPlace } from "../conversation/compaction.js";
import {
  attemptConversationFold,
  rollingSummaryMessage,
  type RollingSummaryState,
} from "../conversation/fold.js";
import type { LoadedDurableMemory } from "../memory/index.js";
import type { DebugTranscriptWriter } from "../debugTranscript/index.js";
import type { SessionLiveEvent, SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { ContinuationContext } from "../sessions/continuation.js";
import { createReadOnlyTools } from "../tools/readOnly.js";
import {
  createToolRegistry,
  type ApprovalHandler,
  type ToolRegistry,
} from "../tools/toolRegistry.js";
import { buildMessages } from "./messages.js";
import type { WorkflowDefinition } from "./workflowDefinition.js";

export interface ActLoopRoute {
  workflow: WorkflowKind;
  stage: "act_loop";
  model: string;
  reason: string;
}

export interface ReactNodeInput {
  modelClient: ModelClient;
  session: AgentSession;
  continuationAttachment?: LoadedContextAttachment;
  contextAttachments: LoadedContextAttachment[];
  durableMemory?: LoadedDurableMemory;
  workspaceRoot: string;
  route: ActLoopRoute;
  plan: AgentPlan;
  limits: BudgetLimits;
  safeCommands: string[];
  commandTimeoutMs: number;
  maxPatchBytes: number;
  maxConversationBytes: number;
  observationDigestPreviewBytes: number;
  protectedRecentTurns: number;
  readScope?: string[];
  act: boolean;
  baselineDirtyPaths: Set<string>;
  tracePath: string;
  continuationContext?: ContinuationContext;
  approvalHandler?: ApprovalHandler;
  onLiveEvent?: SessionLiveEventSink;
  debugTranscript?: DebugTranscriptWriter;
  definition: WorkflowDefinition<unknown>;
  appendTrace(type: string, payload: Record<string, unknown>): Promise<void>;
}

export interface ReactNodeResult {
  status: SessionFinishStatus;
  reason?: SessionStopReason;
  summary: string;
  finalContent?: string;
  audit?: SessionAudit;
}

interface BudgetBlockedToolCalls {
  reason: SessionStopReason;
  skippedCount: number;
}

interface RunAuditState {
  changedFiles: Set<string>;
  commands: { command: string; exitCode: number | null; timedOut: boolean }[];
}

export const modelErrorTracePayload = (
  error: unknown,
): {
  message: string;
  name?: string;
  code?: string;
  causeCategory?: string;
  phase?: string;
  elapsedMs?: number;
  statusCode?: number;
  responseBytes?: number;
  responsePreview?: string;
  providerErrorMessage?: string;
  providerErrorType?: string;
  providerErrorCode?: string;
  diagnosticHint?: string;
} => {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : undefined;
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const code = typeof record.code === "string" ? record.code : undefined;
  const causeCategory =
    typeof record.causeCategory === "string" ? record.causeCategory : undefined;
  const phase = typeof record.phase === "string" ? record.phase : undefined;
  const elapsedMs =
    typeof record.elapsedMs === "number" ? record.elapsedMs : undefined;
  const statusCode =
    typeof record.statusCode === "number" ? record.statusCode : undefined;
  const responseBytes =
    typeof record.responseBytes === "number" ? record.responseBytes : undefined;
  const responsePreview =
    typeof record.responsePreview === "string"
      ? record.responsePreview
      : undefined;
  const providerErrorMessage =
    typeof record.providerErrorMessage === "string"
      ? record.providerErrorMessage
      : undefined;
  const providerErrorType =
    typeof record.providerErrorType === "string"
      ? record.providerErrorType
      : undefined;
  const providerErrorCode =
    typeof record.providerErrorCode === "string"
      ? record.providerErrorCode
      : undefined;
  const diagnosticHint =
    typeof record.diagnosticHint === "string"
      ? record.diagnosticHint
      : undefined;
  return {
    message,
    ...(name ? { name } : {}),
    ...(code ? { code } : {}),
    ...(causeCategory ? { causeCategory } : {}),
    ...(phase ? { phase } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(responseBytes !== undefined ? { responseBytes } : {}),
    ...(responsePreview !== undefined ? { responsePreview } : {}),
    ...(providerErrorMessage ? { providerErrorMessage } : {}),
    ...(providerErrorType ? { providerErrorType } : {}),
    ...(providerErrorCode ? { providerErrorCode } : {}),
    ...(diagnosticHint ? { diagnosticHint } : {}),
  };
};

const liveToolTarget = (toolCall: ModelToolCall): string | undefined => {
  if (!isRecord(toolCall.input)) return undefined;
  if (typeof toolCall.input.path === "string") return toolCall.input.path;
  if (typeof toolCall.input.query === "string") return toolCall.input.query;
  if (typeof toolCall.input.command === "string") return toolCall.input.command;
  return undefined;
};

const liveCommand = (toolCall: ModelToolCall): string | undefined => {
  if (toolCall.name !== "run_command") return undefined;
  if (!isRecord(toolCall.input)) return undefined;
  return typeof toolCall.input.command === "string"
    ? toolCall.input.command
    : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const emitLiveEvent = async (
  sink: SessionLiveEventSink | undefined,
  event: SessionLiveEvent,
): Promise<void> => {
  if (sink) await sink(event);
};

/** Runs the core act loop of the workflow graph, where the model generates text
 * and calls tools in a loop until it returns final content with no tool calls, or
 * a budget limit is exceeded. The model can only call tools that are consistent
 * with the workflow's capability grants, and all tool calls are checked and
 * logged by the kernel for traceability and security.
 */
export const runReactNode = async (
  input: ReactNodeInput,
): Promise<ReactNodeResult> => {
  const usage: BudgetUsage = {
    modelTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  const grantedCapabilities = input.definition.capabilities({
    act: input.act,
    readScope: input.readScope,
  });
  const actionableTools = input.act
    ? (input.definition.createActionableTools?.({
        safeCommands: input.safeCommands,
        commandTimeoutMs: input.commandTimeoutMs,
        maxPatchBytes: input.maxPatchBytes,
        sessionState: {
          baselineDirtyPaths: input.baselineDirtyPaths,
          continuationOwnedDirtyPaths: input.continuationContext
            ? new Set(
                input.continuationContext.priorChangedFiles.flatMap(
                  (item) => item.paths,
                ),
              )
            : undefined,
          forgeletTouchedPaths: new Set(),
        },
      }) ?? [])
    : [];
  const toolRegistry = createToolRegistry(
    [...createReadOnlyTools(input.plan), ...actionableTools],
    {
      approvalHandler: input.approvalHandler,
      onPermissionDecision: async (event) => {
        await emitLiveEvent(input.onLiveEvent, {
          type: "permission_checkpoint",
          toolName: event.toolCall.name,
          decision: event.permissionDecision.kind,
        });
      },
      onToolExecutionStart: async (toolCall) => {
        const command = liveCommand(toolCall);
        if (command)
          await emitLiveEvent(input.onLiveEvent, {
            type: "command_started",
            command,
          });
      },
    },
  );
  const tools = input.definition.offersTools?.({
    continuationAttachment: input.continuationAttachment,
    contextAttachments: input.contextAttachments,
  }) === false
    ? []
    : toolRegistry.listTools(grantedCapabilities);
  const conversation: ModelMessage[] = [];
  const audit: RunAuditState = {
    changedFiles: new Set(),
    commands: [],
  };
  await input.definition.prepareSession?.({ workspaceRoot: input.workspaceRoot });
  let finalContent = "";
  let rollingSummary: RollingSummaryState | undefined;
  let failedFoldAttempts = 0;

  for (let turnIndex = 0; ; turnIndex += 1) {
    const stopReason = budgetStopReason(usage, input.limits);
    if (stopReason) {
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        stopReason,
        input.limits,
      );
      input.session.stage = "final";
      return { status: "stopped", reason: stopReason, summary };
    }

    const remainingModelTurns = input.limits.maxModelTurns - usage.modelTurns;
    const finalOnly = remainingModelTurns === 1;
    const finalToolTurn = remainingModelTurns === 2;
    const compaction = compactConversationInPlace(conversation, {
      maxConversationBytes: input.maxConversationBytes,
      observationDigestPreviewBytes: input.observationDigestPreviewBytes,
      rollingSummaryText: rollingSummary?.text,
    });
    if (
      compaction.compactedCount > 0 ||
      compaction.beforeConversationBytes > compaction.targetConversationBytes
    )
      await input.appendTrace(
        compaction.compactedCount > 0
          ? "conversation_compacted"
          : "conversation_compaction_attempted",
        { ...compaction },
      );

    const foldResult = await attemptConversationFold({
      conversation,
      rollingSummary,
      maxConversationBytes: input.maxConversationBytes,
      protectedRecentTurns: input.protectedRecentTurns,
      task: input.session.task,
      modelClient: input.modelClient,
      failedFoldAttempts,
      onModelRequest: (foldMessages) =>
        input.debugTranscript?.append({
          type: "model_request",
          ts: new Date().toISOString(),
          sessionId: input.session.id,
          payload: {
            turnIndex,
            model: input.route.model,
            purpose: "conversation_fold",
            messages: foldMessages,
            tools: [],
          },
        }),
      onModelResponse: (content) =>
        input.debugTranscript?.append({
          type: "model_response",
          ts: new Date().toISOString(),
          sessionId: input.session.id,
          payload: {
            turnIndex,
            model: input.route.model,
            purpose: "conversation_fold",
            content,
          },
        }),
    });
    if (foldResult.outcome === "stop") {
      await input.appendTrace("conversation_fold_stopped", {
        protectedRecentTurns: input.protectedRecentTurns,
        maxConversationBytes: input.maxConversationBytes,
      });
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        "active_context_exhausted",
        input.limits,
      );
      input.session.stage = "final";
      return { status: "stopped", reason: "active_context_exhausted", summary };
    }
    if (foldResult.outcome === "failed") {
      failedFoldAttempts += 1;
      await input.appendTrace("conversation_fold_failed", {
        reason: foldResult.reason,
        failedAttemptCount: failedFoldAttempts,
      });
    }
    if (foldResult.outcome === "folded") {
      failedFoldAttempts = 0;
      rollingSummary = foldResult.rollingSummary;
      usage.inputTokens += foldResult.usage.inputTokens;
      usage.outputTokens += foldResult.usage.outputTokens;
      usage.estimatedCostUsd += foldResult.usage.estimatedCostUsd;
      await input.appendTrace("conversation_folded", { ...foldResult.trace });
      if (foldResult.trace.narrativeClipped)
        await input.appendTrace("conversation_fold_narrative_clipped", {
          maxConversationBytes: input.maxConversationBytes,
        });
      const foldBudgetStopReason = tokenOrCostBudgetStopReason(
        usage,
        input.limits,
      );
      if (foldBudgetStopReason) {
        const summary = formatStoppedSummary(
          input.session,
          input.route,
          usage,
          foldBudgetStopReason,
          input.limits,
        );
        input.session.stage = "final";
        return { status: "stopped", reason: foldBudgetStopReason, summary };
      }
    }

    const messages = buildMessages(
      input.definition,
      input.session,
      input.plan,
      input.route,
      input.continuationAttachment,
      input.contextAttachments,
      input.durableMemory,
      input.continuationContext,
      usage,
      input.limits,
      conversation,
      input.act,
      compaction.compactedCount > 0
        ? `Active observations compacted: ${compaction.afterConversationBytes}/${compaction.targetConversationBytes} bytes.`
        : undefined,
      rollingSummaryMessage(rollingSummary),
      finalOnly,
      finalToolTurn,
    );
    let output: ModelTurnOutput;
    try {
      await emitLiveEvent(input.onLiveEvent, {
        type: "model_turn_started",
        turnIndex,
        model: input.route.model,
      });
      await input.debugTranscript?.append({
        type: "model_request",
        ts: new Date().toISOString(),
        sessionId: input.session.id,
        payload: {
          turnIndex,
          model: input.route.model,
          task: input.session.task,
          messages,
          tools: finalOnly ? [] : tools,
          finalOnly,
        },
      });
      output = await input.modelClient.createTurn({
        task: input.session.task,
        messages,
        tools: finalOnly ? [] : tools,
        onOutputDelta: input.onLiveEvent
          ? async (delta) => {
              await emitLiveEvent(input.onLiveEvent, {
                type: "model_output_delta",
                turnIndex,
                model: input.route.model,
                text: delta.text,
              });
            }
          : undefined,
      });
      await input.debugTranscript?.append({
        type: "model_response",
        ts: new Date().toISOString(),
        sessionId: input.session.id,
        payload: {
          turnIndex,
          model: input.route.model,
          content: output.content,
          toolCalls: output.toolCalls,
          finishReason: output.finishReason,
          usage: output.usage,
        },
      });
    } catch (error) {
      await input.debugTranscript?.append({
        type: "model_error",
        ts: new Date().toISOString(),
        sessionId: input.session.id,
        payload: {
          turnIndex,
          model: input.route.model,
          finalOnly,
          error: modelErrorTracePayload(error),
        },
      });
      await input.appendTrace("model_turn_error", {
        turnIndex,
        model: input.route.model,
        finalOnly,
        error: modelErrorTracePayload(error),
      });
      throw error;
    }

    usage.modelTurns += 1;
    usage.inputTokens += output.usage?.inputTokens ?? 0;
    usage.outputTokens += output.usage?.outputTokens ?? 0;
    usage.estimatedCostUsd += output.usage?.estimatedCostUsd ?? 0;

    await input.appendTrace("model_turn", {
      turnIndex,
      model: input.route.model,
      contentPreview: output.content?.slice(0, 500),
      toolCalls: output.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
      })),
      usage: output.usage,
      finishReason: output.finishReason,
      finalOnly,
    });
    await emitLiveEvent(input.onLiveEvent, {
      type: "model_turn_finished",
      turnIndex,
      model: input.route.model,
      toolCallCount: output.toolCalls.length,
    });
    await input.appendTrace("budget_update", { usage, limits: input.limits });

    const hardBudgetStopReason = tokenOrCostBudgetStopReason(
      usage,
      input.limits,
    );
    if (hardBudgetStopReason && output.toolCalls.length > 0) {
      await input.appendTrace("budget_blocked_tool_calls", {
        reason: hardBudgetStopReason,
        skippedCount: output.toolCalls.length,
        toolNames: output.toolCalls.map((toolCall) => toolCall.name),
      });
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        hardBudgetStopReason,
        input.limits,
        { reason: hardBudgetStopReason, skippedCount: output.toolCalls.length },
      );
      input.session.stage = "final";
      return {
        status: "stopped",
        reason: hardBudgetStopReason,
        summary,
      };
    }

    if (finalOnly && output.toolCalls.length > 0) {
      await input.appendTrace("budget_blocked_tool_calls", {
        reason: "max_model_turns",
        skippedCount: output.toolCalls.length,
        toolNames: output.toolCalls.map((toolCall) => toolCall.name),
      });
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        "max_model_turns",
        input.limits,
        { reason: "max_model_turns", skippedCount: output.toolCalls.length },
      );
      input.session.stage = "final";
      return {
        status: "stopped",
        reason: "max_model_turns",
        summary,
      };
    }

    if (
      output.toolCalls.length === 0 &&
      !isUsableFinalContent(output.content ?? "")
    ) {
      if (!finalOnly) continue;
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        "max_model_turns",
        input.limits,
      );
      input.session.stage = "final";
      return {
        status: "stopped",
        reason: "max_model_turns",
        summary,
      };
    }

    // No tool calls is the loop exit condition: model content becomes the
    // Session's final answer.
    if (output.toolCalls.length === 0) {
      finalContent = input.definition.normalizeFinalContent?.(
        output.content ?? "",
        { contextAttachments: input.contextAttachments },
      ) ?? (output.content ?? "");
      input.plan.items = input.plan.items.map((item) => ({
        ...item,
        status: "completed",
      }));
      input.session.stage = "final";
      const sessionAudit = input.act
        ? await buildSessionAudit(input, usage, audit)
        : undefined;
      return {
        status: "completed",
        summary: formatCompletedSummary(
          input.session,
          input.route,
          finalContent,
          usage,
          sessionAudit,
        ),
        finalContent,
        audit: sessionAudit,
      };
    }

    conversation.push({
      role: "assistant",
      content: output.content ?? "",
      toolCalls: output.toolCalls,
    });
    for (const toolCall of output.toolCalls) {
      const observation = await executeToolCall({
        toolCall,
        toolRegistry,
        session: input.session,
        workspaceRoot: input.workspaceRoot,
        grantedCapabilities,
        readScope: input.readScope,
        onLiveEvent: input.onLiveEvent,
        turnIndex,
        debugTranscript: input.debugTranscript,
        appendTrace: input.appendTrace,
      });
      recordAuditObservation(audit, observation);
      conversation.push({
        role: "tool",
        toolCallId: observation.toolCallId,
        content: JSON.stringify(observationForModel(observation)),
      });
    }
  }
};

const recordAuditObservation = (
  audit: RunAuditState,
  observation: ToolObservation,
): void => {
  if (observation.toolName === "apply_patch" && observation.ok)
    observation.metadata.changedFiles?.forEach((path) =>
      audit.changedFiles.add(path),
    );
  if (observation.toolName === "run_command")
    audit.commands.push({
      command: observation.metadata.command ?? observation.toolName,
      exitCode: observation.metadata.exitCode ?? null,
      timedOut: observation.metadata.timedOut === true,
    });
};

const buildSessionAudit = async (
  input: ReactNodeInput,
  usage: BudgetUsage,
  audit: RunAuditState,
): Promise<SessionAudit> => {
  const finalDirtyPaths = await gitStatusPaths(input.workspaceRoot);
  const forgeletChanged = [...audit.changedFiles].sort();
  const inheritedForgeletChanged = [
    ...new Set(
      input.continuationContext?.priorChangedFiles.flatMap(
        (item) => item.paths,
      ) ?? [],
    ),
  ].sort();
  const continuationOwnedDirtyPaths = new Set(inheritedForgeletChanged);
  const preExistingAtSessionStart = [...input.baselineDirtyPaths]
    .filter((path) => !continuationOwnedDirtyPaths.has(path))
    .sort();
  const otherCurrentWorkspaceChanges = [...finalDirtyPaths]
    .filter(
      (path) =>
        !audit.changedFiles.has(path) && !input.baselineDirtyPaths.has(path),
    )
    .sort();
  const verificationCommands = audit.commands.map((command) => ({
    command: command.command,
    exitCode: command.exitCode,
    timedOut: command.timedOut,
  }));

  return {
    changeGroups: {
      ...(inheritedForgeletChanged.length > 0
        ? { inheritedForgeletChanged }
        : {}),
      forgeletChanged,
      preExistingAtSessionStart,
      otherCurrentWorkspaceChanges,
    },
    verificationCommands,
    kernelObservedRisks: [
      ...verificationCommands
        .filter((command) => command.timedOut || command.exitCode !== 0)
        .map((command) => ({
          kind: "verification_failed" as const,
          message: command.timedOut
            ? `Verification command timed out: ${command.command}.`
            : `Verification command failed: ${command.command} (exit ${command.exitCode}).`,
          command: command.command,
          exitCode: command.exitCode,
          timedOut: command.timedOut,
        })),
      ...(forgeletChanged.length > 0 && verificationCommands.length === 0
        ? [
            {
              kind: "verification_missing" as const,
              message:
                "No verification command was run for the Forgelet changes.",
            },
          ]
        : []),
      ...(preExistingAtSessionStart.length > 0
        ? [
            {
              kind: "pre_existing_workspace_changes" as const,
              message:
                "Pre-existing workspace changes were present at Session start.",
              paths: preExistingAtSessionStart,
            },
          ]
        : []),
      ...(otherCurrentWorkspaceChanges.length > 0
        ? [
            {
              kind: "other_workspace_changes" as const,
              message:
                "Workspace has current changes not attributed to Forgelet.",
              paths: otherCurrentWorkspaceChanges,
            },
          ]
        : []),
    ],
    modelTurns: usage.modelTurns,
    estimatedCostUsd: usage.estimatedCostUsd,
    tracePath: input.tracePath,
  };
};

/** The tool execution flow enforces capability grants and appends trace events
 * for all decisions and results. Tool calls that are denied or unknown are not
 * thrown as errors, but returned as observations for the model to self-correct.
 */
const executeToolCall = async (input: {
  toolCall: ModelToolCall;
  toolRegistry: ToolRegistry;
  session: AgentSession;
  workspaceRoot: string;
  grantedCapabilities: Capability[];
  readScope?: string[];
  onLiveEvent?: SessionLiveEventSink;
  turnIndex: number;
  debugTranscript?: DebugTranscriptWriter;
  appendTrace(type: string, payload: Record<string, unknown>): Promise<void>;
}): Promise<ToolObservation> => {
  const target = liveToolTarget(input.toolCall);
  await emitLiveEvent(input.onLiveEvent, {
    type: "tool_call_started",
    toolName: input.toolCall.name,
    ...(target ? { target } : {}),
  });
  const command = liveCommand(input.toolCall);
  await input.appendTrace("tool_call", {
    id: input.toolCall.id,
    name: input.toolCall.name,
    input: input.toolCall.input,
  });
  await input.debugTranscript?.append({
    type: "tool_request",
    ts: new Date().toISOString(),
    sessionId: input.session.id,
    payload: {
      turnIndex: input.turnIndex,
      toolCall: input.toolCall,
    },
  });
  const execution = await input.toolRegistry.execute(input.toolCall, {
    workspaceRoot: input.workspaceRoot,
    sessionId: input.session.id,
    workflow: input.session.workflow,
    grantedCapabilities: input.grantedCapabilities,
    readScope: input.readScope,
  });
  await input.appendTrace("permission_decision", {
    toolCallId: input.toolCall.id,
    toolName: input.toolCall.name,
    capability: execution.capability,
    decision: execution.permissionDecision.kind,
    riskTier: execution.permissionDecision.riskTier,
    reason: execution.permissionDecision.reason,
  });
  if (execution.approvalDecision)
    await input.appendTrace("approval_decision", {
      toolCallId: input.toolCall.id,
      toolName: input.toolCall.name,
      status: execution.approvalDecision.status,
      reason: execution.approvalDecision.reason,
      fullPatchShown: execution.approvalDecision.fullPatchShown,
    });
  await input.appendTrace(
    "tool_result",
    traceToolObservation(execution.observation),
  );
  await input.debugTranscript?.append({
    type: "tool_result",
    ts: new Date().toISOString(),
    sessionId: input.session.id,
    payload: {
      turnIndex: input.turnIndex,
      toolCallId: execution.observation.toolCallId,
      toolName: execution.observation.toolName,
      observation: execution.observation,
    },
  });
  if (command)
    await emitLiveEvent(input.onLiveEvent, {
      type: "command_finished",
      command,
      exitCode:
        typeof execution.observation.metadata.exitCode === "number"
          ? execution.observation.metadata.exitCode
          : null,
      timedOut: execution.observation.metadata.timedOut === true,
    });
  await emitLiveEvent(input.onLiveEvent, {
    type: "tool_call_finished",
    toolName: input.toolCall.name,
    ok: execution.observation.ok,
    summary: execution.observation.summary,
  });
  // Plan changes are trace-worthy Session state, not just tool output.
  if (execution.observation.ok && input.toolCall.name === "update_plan")
    await input.appendTrace("plan_update", { plan: input.session.plan });
  return execution.observation;
};

export const gitStatusPaths = (workspaceRoot: string): Promise<Set<string>> => {
  return new Promise((resolvePaths) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd: workspaceRoot },
      (error, stdout) => {
        if (error) {
          resolvePaths(new Set());
          return;
        }
        resolvePaths(
          new Set(
            stdout
              .split("\n")
              .map((line) => line.slice(3).trim())
              .filter((path) => !isInternalSessionTracePath(path))
              .filter(Boolean),
          ),
        );
      },
    );
  });
};

const isInternalSessionTracePath = (path: string): boolean =>
  path === ".forgelet/" ||
  path === ".forgelet/sessions" ||
  path.startsWith(".forgelet/sessions/");

const budgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
): SessionStopReason | undefined => {
  if (usage.modelTurns >= limits.maxModelTurns) return "max_model_turns";
  return tokenOrCostBudgetStopReason(usage, limits);
};

const tokenOrCostBudgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
): SessionStopReason | undefined => {
  if (usage.inputTokens >= limits.maxInputTokens)
    return "input_token_limit_exceeded";
  if (usage.estimatedCostUsd >= limits.maxEstimatedCostUsd)
    return "estimated_cost_budget_exceeded";
  return undefined;
};

const isUsableFinalContent = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return !trimmed.includes("<｜｜DSML｜｜tool_calls>");
};

const observationForModel = (
  observation: ToolObservation,
): Record<string, unknown> => {
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    content: observation.content,
    error: observation.error,
    metadata: observation.metadata,
  };
};

const traceToolObservation = (
  observation: ToolObservation,
): Record<string, unknown> => {
  // Trace payloads intentionally omit `content`; full read-only results should
  // only live in the active model observation.
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    error: observation.error,
    path: observation.metadata.path,
    truncated: observation.metadata.truncated,
    totalBytes: observation.metadata.totalBytes,
    returnedBytes: observation.metadata.returnedBytes,
    contentHash: observation.metadata.contentHash,
    rangeKind: observation.metadata.rangeKind,
    offsetBytes: observation.metadata.offsetBytes,
    limitBytes: observation.metadata.limitBytes,
    startLine: observation.metadata.startLine,
    lineCount: observation.metadata.lineCount,
    tailLines: observation.metadata.tailLines,
    returnedStartByte: observation.metadata.returnedStartByte,
    returnedEndByte: observation.metadata.returnedEndByte,
    returnedStartLine: observation.metadata.returnedStartLine,
    returnedEndLine: observation.metadata.returnedEndLine,
    nextOffsetBytes: observation.metadata.nextOffsetBytes,
    preview: observation.metadata.preview,
    changedFiles: observation.metadata.changedFiles,
    command: observation.metadata.command,
    exitCode: observation.metadata.exitCode,
    durationMs: observation.metadata.durationMs,
    timedOut: observation.metadata.timedOut,
    scopeConstrained: observation.metadata.scopeConstrained,
  };
};

const formatCompletedSummary = (
  session: AgentSession,
  route: ActLoopRoute,
  finalContent: string,
  usage: BudgetUsage,
  audit?: SessionAudit,
): string => {
  return [
    `Forgelet session completed: ${session.id}`,
    `Workflow: ${session.workflow}`,
    ...(session.workflowVariant
      ? [`Workflow variant: ${session.workflowVariant}`]
      : []),
    ...(session.creativeStyle
      ? [`Creative style: ${session.creativeStyle}`]
      : []),
    `Task: ${session.task}`,
    `Task hash: ${session.taskHash}`,
    `Route: ${route.model} (${route.reason})`,
    `Model turns: ${usage.modelTurns}`,
    finalContent,
    ...(audit ? [formatAuditFooter(audit)] : []),
  ].join("\n");
};

const formatAuditFooter = (audit: SessionAudit): string => {
  return [
    "",
    "Audit:",
    `Forgelet changed: ${formatList(audit.changeGroups.forgeletChanged)}`,
    `Pre-existing at Session start: ${formatList(audit.changeGroups.preExistingAtSessionStart)}`,
    `Other current workspace changes: ${formatList(audit.changeGroups.otherCurrentWorkspaceChanges)}`,
    audit.verificationCommands.length > 0
      ? "Verification commands:"
      : "Verification commands: none",
    ...audit.verificationCommands.map(
      (command) =>
        `- Command: ${command.command} (${command.timedOut ? "timed out" : `exit ${command.exitCode}`})`,
    ),
    audit.kernelObservedRisks.length > 0
      ? "Remaining risks:"
      : "Remaining risks: none",
    ...audit.kernelObservedRisks.map((risk) => `- ${risk.message}`),
  ].join("\n");
};

const formatList = (items: string[]): string =>
  items.length > 0 ? items.join(", ") : "none";

const formatStoppedSummary = (
  session: AgentSession,
  route: ActLoopRoute,
  usage: BudgetUsage,
  reason: SessionStopReason,
  limits: BudgetLimits,
  blockedToolCalls?: BudgetBlockedToolCalls,
): string => {
  return [
    `Forgelet session stopped: ${session.id}`,
    `Workflow: ${session.workflow}`,
    `Task: ${session.task}`,
    `Task hash: ${session.taskHash}`,
    `Route: ${route.model} (${route.reason})`,
    `Reason: ${reason}`,
    `Model turns: ${usage.modelTurns}/${limits.maxModelTurns}`,
    `Input tokens: ${usage.inputTokens}/${limits.maxInputTokens}`,
    `Output tokens: ${usage.outputTokens}`,
    `Estimated cost: $${usage.estimatedCostUsd.toFixed(4)}/$${limits.maxEstimatedCostUsd.toFixed(4)}`,
    ...(blockedToolCalls
      ? [
          `Skipped ${blockedToolCalls.skippedCount} tool call${blockedToolCalls.skippedCount === 1 ? "" : "s"} because ${blockedToolCalls.reason} was reached.`,
        ]
      : []),
  ].join("\n");
};
