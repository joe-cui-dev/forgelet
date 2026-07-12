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
  ToolRequest,
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
import type {
  DebugTranscriptEvent,
  DebugTranscriptWriter,
} from "../debugTranscript/index.js";
import type { SessionLiveEvent, SessionLiveEventSink } from "../sessionLiveView/index.js";
import {
  createResumeApprovalHandler,
  SessionPauseSignal,
  type EffectEnvelope,
} from "../permissions/envelope.js";
import type { ContinuationContext } from "../sessions/continuation.js";
import { createReadOnlyTools } from "../tools/readOnly.js";
import {
  createToolRegistry,
  type ApprovalHandler,
  type ToolRegistry,
} from "../tools/toolRegistry.js";
import { buildMessages } from "./messages.js";
import type { ExecutionPolicy, WorkflowDefinition } from "./workflowDefinition.js";

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
  executionPolicy?: ExecutionPolicy;
  /** The only user cancellation path; only this owned signal converts to
   * `user_stopped`, never an arbitrary provider/transport abort. */
  signal?: AbortSignal;
  approvalHandler?: ApprovalHandler;
  envelope?: EffectEnvelope;
  resume?: ReactNodeResumeState;
  /** Injectable clock for deterministic wall-clock budget tests; defaults to Date.now. */
  now?: () => number;
  onLiveEvent?: SessionLiveEventSink;
  debugTranscript?: DebugTranscriptWriter;
  definition: WorkflowDefinition<unknown>;
  /** ts lets a caller preserve the real moment an event happened when the
   * append itself is deferred (e.g. flushing buffered events from
   * concurrently-executed read tool calls after the group settles). */
  appendTrace(
    type: string,
    payload: Record<string, unknown>,
    ts?: string,
  ): Promise<void>;
}

/** Restored loop state for re-entering a paused Session. The pending call is
 * resolved (approved, denied, or abandoned via stop) before the main loop
 * resumes at resume.turnIndex + 1; approve-and-widen is expressed by the
 * caller passing an already-widened `envelope` alongside decision "approve". */
export interface ReactNodeResumeState {
  decision: "approve" | "deny" | "stop";
  pendingToolCall: ModelToolCall;
  remainingToolCalls: ModelToolCall[];
  conversation: ModelMessage[];
  rollingSummary?: RollingSummaryState;
  failedFoldAttempts: number;
  usage: BudgetUsage;
  turnIndex: number;
  audit: {
    changedFiles: string[];
    commands: { command: string; exitCode: number | null; timedOut: boolean }[];
  };
  sessionState: ReactNodePausedSessionState;
  activeWallClockMs: number;
}

export type ReactNodeResult = ReactNodeFinishResult | ReactNodePausedResult;

export interface ReactNodeFinishResult {
  status: SessionFinishStatus;
  reason?: SessionStopReason;
  summary: string;
  finalContent?: string;
  audit?: SessionAudit;
}

export interface ReactNodePausedSessionState {
  baselineDirtyPaths: Set<string>;
  continuationOwnedDirtyPaths?: Set<string>;
  forgeletTouchedPaths: Set<string>;
}

export interface ReactNodePausedResult {
  status: "paused";
  pendingToolCall: ModelToolCall;
  pendingToolRequest: ToolRequest;
  remainingToolCalls: ModelToolCall[];
  executedObservations: ToolObservation[];
  conversation: ModelMessage[];
  rollingSummary?: RollingSummaryState;
  failedFoldAttempts: number;
  usage: BudgetUsage;
  turnIndex: number;
  audit: {
    changedFiles: string[];
    commands: { command: string; exitCode: number | null; timedOut: boolean }[];
  };
  sessionState: ReactNodePausedSessionState;
  activeWallClockMs: number;
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

// Bounded retry for transient model-turn errors only; the conversation-fold
// model call has its own failure tolerance (Degraded Fold, ADR 0022) and is
// deliberately left untouched here.
const MODEL_TURN_MAX_RETRIES = 2;
const MODEL_TURN_RETRY_BASE_DELAY_MS = 250;

const RETRYABLE_CAUSE_CATEGORIES = new Set([
  "request_error",
  "response_aborted",
  "response_aborted_empty_body",
  "response_error",
  "timeout",
]);

/** A statusCode, when present, means a real HTTP response was received and
 * takes priority over causeCategory: only 429/5xx are transient. Absent a
 * statusCode, classify by causeCategory (network/timeout errors are
 * transient; malformed-response categories like invalid_json are not). */
const isRetryableModelTurnError = (error: unknown): boolean => {
  const record = isRecord(error) ? error : {};
  const statusCode =
    typeof record.statusCode === "number" ? record.statusCode : undefined;
  if (statusCode !== undefined) return statusCode === 429 || statusCode >= 500;
  const causeCategory =
    typeof record.causeCategory === "string" ? record.causeCategory : undefined;
  return causeCategory !== undefined && RETRYABLE_CAUSE_CATEGORIES.has(causeCategory);
};

const modelTurnRetryDelayMs = (attempt: number): number => {
  const backoff = MODEL_TURN_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  const jitter = Math.random() * MODEL_TURN_RETRY_BASE_DELAY_MS;
  return Math.round(backoff + jitter);
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolveWait) => setTimeout(resolveWait, ms));

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
  const now = input.now ?? Date.now;
  const runStartedAtMs = now();
  const priorWallClockMs = input.resume?.activeWallClockMs ?? 0;
  const elapsedWallClockMs = (): number => priorWallClockMs + (now() - runStartedAtMs);
  const usage: BudgetUsage = input.resume
    ? { ...input.resume.usage }
    : { modelTurns: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const grantedCapabilities = input.definition.capabilities({
    act: input.act,
    readScope: input.readScope,
  });
  const actionableSessionState: ReactNodePausedSessionState = input.resume
    ? input.resume.sessionState
    : {
        baselineDirtyPaths: input.baselineDirtyPaths,
        continuationOwnedDirtyPaths: input.continuationContext
          ? new Set(
              input.continuationContext.priorChangedFiles.flatMap(
                (item) => item.paths,
              ),
            )
          : undefined,
        forgeletTouchedPaths: new Set(),
      };
  const actionableTools = input.act
    ? (input.definition.createActionableTools?.({
        safeCommands: input.safeCommands,
        commandTimeoutMs: input.commandTimeoutMs,
        maxPatchBytes: input.maxPatchBytes,
        sessionState: actionableSessionState,
      }) ?? [])
    : [];
  const toolRegistry = createToolRegistry(
    [...createReadOnlyTools(input.plan), ...actionableTools],
    {
      approvalHandler: input.resume
        ? createResumeApprovalHandler(
            input.resume.pendingToolCall.id,
            input.resume.decision === "approve" ? "approve" : "deny",
            input.envelope ?? { writeScopePrefixes: [], allowedCommands: [] },
            input.resume.decision === "stop"
              ? "Session stopped by user via `forge decide`."
              : "Denied by user via `forge decide`.",
          )
        : input.approvalHandler,
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
  const conversation: ModelMessage[] = input.resume
    ? input.resume.conversation
    : [];
  const audit: RunAuditState = input.resume
    ? {
        changedFiles: new Set(input.resume.audit.changedFiles),
        commands: [...input.resume.audit.commands],
      }
    : { changedFiles: new Set(), commands: [] };
  await input.definition.prepareSession?.({ workspaceRoot: input.workspaceRoot });
  let finalContent = "";
  let rollingSummary: RollingSummaryState | undefined = input.resume?.rollingSummary;
  let failedFoldAttempts = input.resume?.failedFoldAttempts ?? 0;
  let forcedStopReason: SessionStopReason | undefined;

  if (input.resume) {
    const batchOutcome = await executeToolCallBatch({
      toolCalls: [input.resume.pendingToolCall, ...input.resume.remainingToolCalls],
      toolRegistry,
      session: input.session,
      workspaceRoot: input.workspaceRoot,
      grantedCapabilities,
      readScope: input.readScope,
      onLiveEvent: input.onLiveEvent,
      turnIndex: input.resume.turnIndex,
      debugTranscript: input.debugTranscript,
      appendTrace: input.appendTrace,
      audit,
    });
    if (batchOutcome.outcome === "paused")
      return {
        status: "paused",
        pendingToolCall: batchOutcome.pendingToolCall,
        pendingToolRequest: batchOutcome.pendingToolRequest,
        remainingToolCalls: batchOutcome.remainingToolCalls,
        executedObservations: batchOutcome.executedObservations,
        conversation,
        rollingSummary,
        failedFoldAttempts,
        usage,
        turnIndex: input.resume.turnIndex,
        audit: {
          changedFiles: [...audit.changedFiles],
          commands: audit.commands,
        },
        sessionState: actionableSessionState,
        activeWallClockMs: elapsedWallClockMs(),
      };
    for (const observation of batchOutcome.observations)
      conversation.push({
        role: "tool",
        toolCallId: observation.toolCallId,
        content: JSON.stringify(observationForModel(observation)),
      });
    if (input.resume.decision === "stop") forcedStopReason = "user_stopped";
  }

  for (
    let turnIndex = input.resume ? input.resume.turnIndex + 1 : 0;
    ;
    turnIndex += 1
  ) {
    const stopReason = budgetStopReason(usage, input.limits, elapsedWallClockMs());
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

    const isAnswerOnce = input.executionPolicy === "answer_once";
    const remainingModelTurns = input.limits.maxModelTurns - usage.modelTurns;
    const finalOnly = isAnswerOnce || remainingModelTurns === 1;
    const finalToolTurn = !isAnswerOnce && remainingModelTurns === 2;
    const budgetWrapupReason = finalOnly
      ? undefined
      : (forcedStopReason ??
        budgetWrapupStopReason(usage, input.limits, elapsedWallClockMs()));
    forcedStopReason = undefined;
    if (budgetWrapupReason)
      await input.appendTrace("budget_wrapup_triggered", {
        turnIndex,
        reason: budgetWrapupReason,
        usage,
        limits: input.limits,
        reserveFraction: BUDGET_WRAPUP_RESERVE_FRACTION,
        elapsedWallClockMs: elapsedWallClockMs(),
      });
    const wrapupOnly = finalOnly || budgetWrapupReason !== undefined;
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
      wrapupOnly,
      finalToolTurn,
    );
    if (input.signal?.aborted) return cancelledStopResult(input, usage);

    let output: ModelTurnOutput;
    for (let attempt = 1; ; attempt += 1) {
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
            tools: wrapupOnly ? [] : tools,
            finalOnly: wrapupOnly,
          },
        });
        output = await input.modelClient.createTurn({
          messages,
          tools: wrapupOnly ? [] : tools,
          signal: input.signal,
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
        break;
      } catch (error) {
        if (input.signal?.aborted) return cancelledStopResult(input, usage);
        if (
          attempt <= MODEL_TURN_MAX_RETRIES &&
          isRetryableModelTurnError(error)
        ) {
          const delayMs = modelTurnRetryDelayMs(attempt);
          await input.debugTranscript?.append({
            type: "model_error",
            ts: new Date().toISOString(),
            sessionId: input.session.id,
            payload: {
              turnIndex,
              model: input.route.model,
              finalOnly: wrapupOnly,
              attempt,
              maxRetries: MODEL_TURN_MAX_RETRIES,
              delayMs,
              error: modelErrorTracePayload(error),
            },
          });
          await input.appendTrace("model_turn_retry", {
            turnIndex,
            model: input.route.model,
            finalOnly: wrapupOnly,
            attempt,
            maxRetries: MODEL_TURN_MAX_RETRIES,
            delayMs,
            error: modelErrorTracePayload(error),
          });
          await wait(delayMs);
          continue;
        }
        await input.debugTranscript?.append({
          type: "model_error",
          ts: new Date().toISOString(),
          sessionId: input.session.id,
          payload: {
            turnIndex,
            model: input.route.model,
            finalOnly: wrapupOnly,
            error: modelErrorTracePayload(error),
          },
        });
        await input.appendTrace("model_turn_error", {
          turnIndex,
          model: input.route.model,
          finalOnly: wrapupOnly,
          error: modelErrorTracePayload(error),
        });
        throw error;
      }
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

    if (wrapupOnly && output.toolCalls.length > 0) {
      const reason =
        budgetWrapupReason ??
        (isAnswerOnce ? "answer_once_tool_calls_blocked" : "max_model_turns");
      await input.appendTrace("budget_blocked_tool_calls", {
        reason,
        skippedCount: output.toolCalls.length,
        toolNames: output.toolCalls.map((toolCall) => toolCall.name),
      });
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        reason,
        input.limits,
        { reason, skippedCount: output.toolCalls.length },
      );
      input.session.stage = "final";
      return {
        status: "stopped",
        reason,
        summary,
      };
    }

    if (
      output.toolCalls.length === 0 &&
      !isUsableFinalContent(output.content ?? "")
    ) {
      if (!wrapupOnly) continue;
      const reason = budgetWrapupReason ?? "max_model_turns";
      const summary = formatStoppedSummary(
        input.session,
        input.route,
        usage,
        reason,
        input.limits,
      );
      input.session.stage = "final";
      return {
        status: "stopped",
        reason,
        summary,
      };
    }

    // No tool calls is the loop exit condition: model content becomes the
    // Session's final answer, unless a budget wrap-up triggered this closing
    // turn — that finishes as a stopped Session with the wrap-up content
    // attached, so onCompleted effects do not fire for it (gated on
    // status === "completed" in session.ts).
    if (output.toolCalls.length === 0 && budgetWrapupReason) {
      const wrapupContent = input.definition.normalizeFinalContent?.(
        output.content ?? "",
        { contextAttachments: input.contextAttachments },
      ) ?? (output.content ?? "");
      input.session.stage = "final";
      const summary = formatBudgetWrapupSummary(
        input.session,
        input.route,
        usage,
        budgetWrapupReason,
        input.limits,
        wrapupContent,
      );
      return {
        status: "stopped",
        reason: budgetWrapupReason,
        summary,
        finalContent: wrapupContent,
      };
    }

    // No tool calls is the loop exit condition: model content becomes the
    // Session's final answer.
    if (output.toolCalls.length === 0) {
      // Checked before completion effects (onCompleted may have durable side
      // effects such as saving a Writing Artifact) so a Stop pressed the
      // instant the model finished still discards the completion honestly.
      if (input.signal?.aborted) return cancelledStopResult(input, usage);
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
    const batchOutcome = await executeToolCallBatch({
      toolCalls: output.toolCalls,
      toolRegistry,
      session: input.session,
      workspaceRoot: input.workspaceRoot,
      grantedCapabilities,
      readScope: input.readScope,
      onLiveEvent: input.onLiveEvent,
      turnIndex,
      debugTranscript: input.debugTranscript,
      appendTrace: input.appendTrace,
      audit,
    });
    if (batchOutcome.outcome === "paused")
      return {
        status: "paused",
        pendingToolCall: batchOutcome.pendingToolCall,
        pendingToolRequest: batchOutcome.pendingToolRequest,
        remainingToolCalls: batchOutcome.remainingToolCalls,
        executedObservations: batchOutcome.executedObservations,
        conversation,
        rollingSummary,
        failedFoldAttempts,
        usage,
        turnIndex,
        audit: {
          changedFiles: [...audit.changedFiles],
          commands: audit.commands,
        },
        sessionState: actionableSessionState,
        activeWallClockMs: elapsedWallClockMs(),
      };
    for (const observation of batchOutcome.observations) {
      conversation.push({
        role: "tool",
        toolCallId: observation.toolCallId,
        content: JSON.stringify(observationForModel(observation)),
      });
    }
  }
};

// Only calls whose capability is read-only (never subject to interactive
// approval, see permissions/index.ts) may run concurrently; everything else
// (writes, commands, plan updates) keeps strict serial order. Consecutive
// read-capability calls form one parallel group; any other call is its own
// serial group, so relative ordering across groups is unaffected.
const PARALLEL_READ_CAPABILITIES = new Set<Capability>([
  "read_context",
  "read_workspace",
  "git_read",
]);
const MAX_PARALLEL_TOOL_CALLS = 4;

type ToolCallGroup =
  | { kind: "parallel_read"; toolCalls: ModelToolCall[] }
  | { kind: "serial"; toolCall: ModelToolCall };

export const groupToolCallsForExecution = (
  toolCalls: ModelToolCall[],
  toolRegistry: ToolRegistry,
): ToolCallGroup[] => {
  const groups: ToolCallGroup[] = [];
  for (const toolCall of toolCalls) {
    const capability = toolRegistry.capabilityFor(toolCall.name);
    const isParallelSafe =
      capability !== undefined && PARALLEL_READ_CAPABILITIES.has(capability);
    const lastGroup = groups.at(-1);
    if (isParallelSafe && lastGroup?.kind === "parallel_read") {
      lastGroup.toolCalls.push(toolCall);
    } else if (isParallelSafe) {
      groups.push({ kind: "parallel_read", toolCalls: [toolCall] });
    } else {
      groups.push({ kind: "serial", toolCall });
    }
  }
  return groups;
};

export type ToolCallBatchOutcome =
  | { outcome: "completed"; observations: ToolObservation[] }
  | {
      outcome: "paused";
      pendingToolCall: ModelToolCall;
      pendingToolRequest: ToolRequest;
      remainingToolCalls: ModelToolCall[];
      executedObservations: ToolObservation[];
    };

/** Executes one model turn's tool calls, respecting the same serial/parallel
 * grouping as the main loop. Stops and reports "paused" the moment a serial
 * call throws SessionPauseSignal, since the Effect Envelope only ever governs
 * confirm-tier (serial) calls, never the parallel read-only group. Reused by
 * both the initial run and the resume preamble so pausing can recur while a
 * resumed batch's remaining calls are executed. */
export const executeToolCallBatch = async (input: {
  toolCalls: ModelToolCall[];
  toolRegistry: ToolRegistry;
  session: AgentSession;
  workspaceRoot: string;
  grantedCapabilities: Capability[];
  readScope?: string[];
  onLiveEvent?: SessionLiveEventSink;
  turnIndex: number;
  debugTranscript?: DebugTranscriptWriter;
  appendTrace(
    type: string,
    payload: Record<string, unknown>,
    ts?: string,
  ): Promise<void>;
  audit: RunAuditState;
}): Promise<ToolCallBatchOutcome> => {
  const executedObservations: ToolObservation[] = [];
  for (const group of groupToolCallsForExecution(
    input.toolCalls,
    input.toolRegistry,
  )) {
    let observations: ToolObservation[];
    if (group.kind === "serial") {
      try {
        observations = [
          await executeToolCall({
            toolCall: group.toolCall,
            toolRegistry: input.toolRegistry,
            session: input.session,
            workspaceRoot: input.workspaceRoot,
            grantedCapabilities: input.grantedCapabilities,
            readScope: input.readScope,
            onLiveEvent: input.onLiveEvent,
            turnIndex: input.turnIndex,
            debugTranscript: input.debugTranscript,
            appendTrace: input.appendTrace,
          }),
        ];
      } catch (error) {
        if (!(error instanceof SessionPauseSignal)) throw error;
        const pendingIndex = input.toolCalls.findIndex(
          (toolCall) => toolCall.id === error.toolCall.id,
        );
        return {
          outcome: "paused",
          pendingToolCall: error.toolCall,
          pendingToolRequest: error.toolRequest,
          remainingToolCalls: input.toolCalls.slice(pendingIndex + 1),
          executedObservations,
        };
      }
    } else {
      observations = await executeParallelReadToolCalls({
        toolCalls: group.toolCalls,
        toolRegistry: input.toolRegistry,
        session: input.session,
        workspaceRoot: input.workspaceRoot,
        grantedCapabilities: input.grantedCapabilities,
        readScope: input.readScope,
        onLiveEvent: input.onLiveEvent,
        turnIndex: input.turnIndex,
        debugTranscript: input.debugTranscript,
        appendTrace: input.appendTrace,
      });
    }
    for (const observation of observations) {
      recordAuditObservation(input.audit, observation);
      executedObservations.push(observation);
    }
  }
  return { outcome: "completed", observations: executedObservations };
};

/** Runs a concurrency-limited map over items, returning results in the
 * original item order regardless of completion order. */
const mapWithConcurrencyLimit = async <T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await mapper(items[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
};

/** Executes a group of read-capability tool calls concurrently. Trace and
 * Debug Transcript events are buffered per call (each keeping the real
 * timestamp of the moment it actually happened) and flushed in original
 * tool-call order after the group settles, so replay/debug stays
 * deterministic even though execution itself is not. Live events pass
 * through immediately and may interleave, since they are presentation only
 * (ADR 0015). Conversation order is guaranteed by returning observations in
 * the original tool-call order, not completion order. */
export const executeParallelReadToolCalls = async (input: {
  toolCalls: ModelToolCall[];
  toolRegistry: ToolRegistry;
  session: AgentSession;
  workspaceRoot: string;
  grantedCapabilities: Capability[];
  readScope?: string[];
  onLiveEvent?: SessionLiveEventSink;
  turnIndex: number;
  debugTranscript?: DebugTranscriptWriter;
  appendTrace(
    type: string,
    payload: Record<string, unknown>,
    ts?: string,
  ): Promise<void>;
}): Promise<ToolObservation[]> => {
  const perCallTraceEvents: {
    type: string;
    payload: Record<string, unknown>;
    ts: string;
  }[][] = input.toolCalls.map(() => []);
  const perCallDebugEvents: DebugTranscriptEvent[][] = input.toolCalls.map(
    () => [],
  );

  const observations = await mapWithConcurrencyLimit(
    input.toolCalls,
    MAX_PARALLEL_TOOL_CALLS,
    (toolCall, index) =>
      executeToolCall({
        toolCall,
        toolRegistry: input.toolRegistry,
        session: input.session,
        workspaceRoot: input.workspaceRoot,
        grantedCapabilities: input.grantedCapabilities,
        readScope: input.readScope,
        onLiveEvent: input.onLiveEvent,
        turnIndex: input.turnIndex,
        debugTranscript: input.debugTranscript
          ? {
              path: input.debugTranscript.path,
              append: async (event) => {
                perCallDebugEvents[index]?.push(event);
              },
            }
          : undefined,
        appendTrace: async (type, payload) => {
          perCallTraceEvents[index]?.push({
            type,
            payload,
            ts: new Date().toISOString(),
          });
        },
      }),
  );

  for (const events of perCallTraceEvents)
    for (const event of events)
      await input.appendTrace(event.type, event.payload, event.ts);
  for (const events of perCallDebugEvents)
    for (const event of events) await input.debugTranscript?.append(event);

  return observations;
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
  path === ".forgelet" || path === ".forgelet/" || path.startsWith(".forgelet/");

const budgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
  elapsedWallClockMs: number,
): SessionStopReason | undefined => {
  if (usage.modelTurns >= limits.maxModelTurns) return "max_model_turns";
  if (elapsedWallClockMs >= limits.maxWallClockMs)
    return "wall_clock_limit_exceeded";
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

// Reserve fraction for the proactive budget wrap-up: once usage crosses this
// share of a token/cost limit, the loop stops issuing tool-capable turns and
// gives the model a closing turn instead of running cold into the hard stop.
const BUDGET_WRAPUP_RESERVE_FRACTION = 0.9;

const budgetWrapupStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
  elapsedWallClockMs: number,
): SessionStopReason | undefined => {
  if (usage.inputTokens >= limits.maxInputTokens * BUDGET_WRAPUP_RESERVE_FRACTION)
    return "input_token_limit_exceeded";
  if (
    usage.estimatedCostUsd >=
    limits.maxEstimatedCostUsd * BUDGET_WRAPUP_RESERVE_FRACTION
  )
    return "estimated_cost_budget_exceeded";
  if (elapsedWallClockMs >= limits.maxWallClockMs * BUDGET_WRAPUP_RESERVE_FRACTION)
    return "wall_clock_limit_exceeded";
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

/** Only the owned `input.signal` reaching this point converts to
 * `user_stopped` — arbitrary provider/transport aborts are never
 * pattern-matched here, so a real network failure keeps its honest reason. */
const cancelledStopResult = (
  input: ReactNodeInput,
  usage: BudgetUsage,
): ReactNodeFinishResult => {
  input.session.stage = "final";
  return {
    status: "stopped",
    reason: "user_stopped",
    summary: formatStoppedSummary(
      input.session,
      input.route,
      usage,
      "user_stopped",
      input.limits,
    ),
  };
};

const formatBudgetWrapupSummary = (
  session: AgentSession,
  route: ActLoopRoute,
  usage: BudgetUsage,
  reason: SessionStopReason,
  limits: BudgetLimits,
  wrapupContent: string,
): string => {
  return [
    formatStoppedSummary(session, route, usage, reason, limits),
    "",
    "The model produced a wrap-up answer before the budget stop:",
    wrapupContent,
  ].join("\n");
};
