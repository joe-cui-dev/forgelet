import type {
  AgentPlan,
  AgentSession,
  BudgetLimits,
  BudgetUsage,
  Capability,
  CreativeStyle,
  LoadedContextAttachment,
  ModelClient,
  ModelMessage,
  ModelToolCall,
  ModelTurnOutput,
  SessionFinishStatus,
  SessionStopReason,
  SessionAudit,
  ToolObservation,
  TraceEvent,
  WritingArtifact,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadConfig, routeModel } from "../config/index.js";
import { loadContextAttachments } from "../context/index.js";
import { compactConversationInPlace } from "../conversation/compaction.js";
import { loadDurableMemory, type LoadedDurableMemory } from "../memory/index.js";
import { normalizeSessionReadScope } from "../readScope/index.js";
import type { SessionLiveEvent, SessionLiveEventSink } from "../sessionLiveView/index.js";
import {
  buildContinuationContext,
  continuationContextTracePayload,
  formatContinuationContextForPrompt,
  type ContinuationContext,
} from "../sessions/continuation.js";
import { createTraceWriter } from "../trace/index.js";
import { createActionableCodingTools } from "../tools/actionable.js";
import { createReadOnlyTools } from "../tools/readOnly.js";
import {
  createToolRegistry,
  type ApprovalHandler,
  type ToolRegistry,
} from "../tools/toolRegistry.js";

export interface RunWorkflowInput {
  workflow: WorkflowKind;
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  task: string;
  contextFiles: string[];
  allowedReadPaths?: string[];
  model?: string;
  budgetUsd?: number;
  homeDir?: string;
  workspaceRoot: string;
  modelClient?: ModelClient;
  act?: boolean;
  continuationSourceSessionId?: string;
  approvalHandler?: ApprovalHandler;
  onLiveEvent?: SessionLiveEventSink;
}

export interface RunWorkflowResult {
  session: AgentSession;
  summary: string;
  tracePath: string;
  writingArtifact?: WritingArtifact;
}

interface ActLoopRoute {
  workflow: WorkflowKind;
  stage: "act_loop";
  model: string;
  reason: string;
}

interface RunReadOnlyLoopInput {
  modelClient: ModelClient;
  session: AgentSession;
  contextAttachments: LoadedContextAttachment[];
  durableMemory?: LoadedDurableMemory;
  workspaceRoot: string;
  route: ActLoopRoute;
  plan: AgentPlan;
  limits: BudgetLimits;
  safeCommands: string[];
  commandTimeoutMs: number;
  maxPatchBytes: number;
  maxObservationBytes: number;
  observationDigestPreviewBytes: number;
  readScope?: string[];
  act: boolean;
  baselineDirtyPaths: Set<string>;
  tracePath: string;
  continuationContext?: ContinuationContext;
  approvalHandler?: ApprovalHandler;
  onLiveEvent?: SessionLiveEventSink;
  appendTrace(type: string, payload: Record<string, unknown>): Promise<void>;
}

interface RunReadOnlyLoopResult {
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

const CONTEXT_ATTACHMENT_PROMPT_LIMIT_BYTES = 20 * 1024;
const CONTEXT_ATTACHMENTS_PROMPT_LIMIT_BYTES = 60 * 1024;

/**
 * Runs a Forgelet workflow session with the given input, returning the final
 * session state and a human-readable summary. The model can call only the tools
 * granted to its workflow; writing artifacts are produced by Forgelet after the
 * model returns final content.
 */
export const runWorkflowSession = async (
  input: RunWorkflowInput,
): Promise<RunWorkflowResult> => {
  const now = new Date().toISOString();
  const sessionId = `sess_${Date.now().toString(36)}`;
  const taskHash = hashTask(input.task);
  const continuationContext = input.continuationSourceSessionId
    ? await buildContinuationContext(
        input.workspaceRoot,
        input.continuationSourceSessionId,
      )
    : undefined;
  const readScope = await normalizeSessionReadScope(
    input.workspaceRoot,
    input.allowedReadPaths ?? continuationContext?.inheritedReadScope,
  );
  const traceWriter = await createTraceWriter(input.workspaceRoot, sessionId);
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_started",
    workflow: input.workflow,
    task: input.task,
  });
  await emitLiveEvent(input.onLiveEvent, {
    type: "trace_path",
    tracePath: traceWriter.tracePath,
  });
  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const baselineDirtyPaths =
    input.act && input.workflow === "coding"
      ? await gitStatusPaths(input.workspaceRoot)
      : new Set<string>();
  const contextAttachments = await loadContextAttachments(
    input.workspaceRoot,
    input.contextFiles,
  );
  const durableMemory = input.modelClient
    ? await loadDurableMemory(input.workspaceRoot)
    : undefined;
  const route = selectRoute(
    input.workflow,
    routeModel(config, input.workflow, input.model),
  );
  const plan: AgentPlan = {
    items: [
      { step: "Create session and load task context", status: "completed" },
      { step: "Run workflow graph with model and tools", status: "pending" },
    ],
  };

  const session: AgentSession = {
    id: sessionId,
    workflow: input.workflow,
    ...(input.workflowVariant ? { workflowVariant: input.workflowVariant } : {}),
    ...(input.creativeStyle ? { creativeStyle: input.creativeStyle } : {}),
    task: input.task,
    taskHash,
    ...(readScope ? { readScope } : {}),
    stage: "final",
    plan,
    createdAt: now,
  };

  await traceWriter.append(
    createTraceEvent(sessionId, "session_started", now, {
      workflow: input.workflow,
      ...(input.workflowVariant ? { workflowVariant: input.workflowVariant } : {}),
      ...(input.creativeStyle ? { creativeStyle: input.creativeStyle } : {}),
      startedAt: now,
      taskHash,
      ...(readScope ? { readScope } : {}),
      ...(continuationContext
        ? {
            continuation: {
              sourceSessionId: continuationContext.lineage.sourceSessionId,
              rootSessionId: continuationContext.lineage.rootSessionId,
              lineageSessionIds: continuationContext.lineage.sessionIds,
              degraded: continuationContext.lineage.degraded,
            },
          }
        : {}),
    }),
  );
  await traceWriter.append(
    createTraceEvent(sessionId, "user_task", now, { task: input.task }),
  );
  if (continuationContext) {
    await traceWriter.append(
      createTraceEvent(sessionId, "session_continuation_started", now, {
        sourceSessionId: continuationContext.lineage.sourceSessionId,
        lineageSessionIds: continuationContext.lineage.sessionIds,
        lineageDepth: continuationContext.lineage.sessionIds.length,
        degraded: continuationContext.lineage.degraded,
        incompleteReasons: continuationContext.lineage.incompleteReasons,
        inheritedWorkflow: input.workflow,
        inheritedReadScope: continuationContext.inheritedReadScope,
      }),
    );
    await traceWriter.append(
      createTraceEvent(
        sessionId,
        "continuation_context_loaded",
        now,
        continuationContextTracePayload(continuationContext),
      ),
    );
  }
  for (const contextAttachment of contextAttachments) {
    await traceWriter.append(
      createTraceEvent(
        sessionId,
        "context_attachment",
        now,
        contextAttachment.attachment as unknown as Record<string, unknown>,
      ),
    );
  }
  if (durableMemory)
    await traceWriter.append(
      createTraceEvent(sessionId, "memory_loaded", now, {
        path: durableMemory.path,
        contentBytes: durableMemory.contentBytes,
        returnedBytes: durableMemory.returnedBytes,
        contentHash: durableMemory.contentHash,
        preview: durableMemory.preview,
        truncated: durableMemory.truncated,
      }),
    );
  await traceWriter.append(
    createTraceEvent(sessionId, "routing_selected", now, { ...route }),
  );
  if (input.act && input.workflow === "coding")
    await traceWriter.append(
      createTraceEvent(sessionId, "workspace_baseline", now, {
        dirtyPaths: [...baselineDirtyPaths],
      }),
    );
  await traceWriter.append(
    createTraceEvent(sessionId, "plan_update", now, { plan }),
  );

  // Real model execution is opt-in for now so the CLI scaffold keeps its
  // current behavior until a provider is wired into the command path.
  if (input.modelClient) {
    let execution: RunReadOnlyLoopResult;
    try {
      execution = await runReadOnlyLoop({
        modelClient: input.modelClient,
        session,
        contextAttachments,
        durableMemory,
        workspaceRoot: input.workspaceRoot,
        route,
        plan,
        limits: {
          ...config.budgets,
          maxEstimatedCostUsd:
            input.budgetUsd ?? config.budgets.maxEstimatedCostUsd,
        },
        safeCommands: config.safeCommands,
        commandTimeoutMs: config.commandTimeoutMs,
        maxPatchBytes: config.maxPatchBytes,
        maxObservationBytes: config.activeContext.maxObservationBytes,
        observationDigestPreviewBytes:
          config.activeContext.observationDigestPreviewBytes,
        readScope,
        act: input.act === true && input.workflow === "coding",
        baselineDirtyPaths,
        tracePath: traceWriter.tracePath,
        continuationContext,
        approvalHandler: input.approvalHandler,
        onLiveEvent: input.onLiveEvent,
        appendTrace: (type, payload) =>
          traceWriter.append(
            createTraceEvent(sessionId, type, new Date().toISOString(), payload),
          ),
      });
    } catch (error) {
      const failure = modelExecutionFailurePayload(error, traceWriter.tracePath);
      await traceWriter.append(
        createTraceEvent(sessionId, "final_summary", new Date().toISOString(), {
          summary: failure.summary,
          error: failure.error,
        }),
      );
      await traceWriter.append(
        createTraceEvent(
          sessionId,
          "session_finished",
          new Date().toISOString(),
          {
            status: "failed",
            reason: "model_execution_error",
            error: failure.error,
            finishedAt: new Date().toISOString(),
          },
        ),
      );
      await emitLiveEvent(input.onLiveEvent, {
        type: "session_finished",
        status: "failed",
        reason: "model_execution_error",
      });
      throw error;
    }

    const writingArtifact =
      execution.status === "completed" &&
      input.workflow === "writing" &&
      execution.finalContent
        ? await writeWritingArtifact({
            workspaceRoot: input.workspaceRoot,
            session,
            finalContent: execution.finalContent,
            contextAttachmentCount: contextAttachments.length,
          })
        : undefined;
    const executionSummary = writingArtifact
      ? appendWritingArtifactLine(execution.summary, writingArtifact)
      : execution.summary;

    if (writingArtifact)
      await traceWriter.append(
        createTraceEvent(
          sessionId,
          "writing_artifact",
          new Date().toISOString(),
          writingArtifact as unknown as Record<string, unknown>,
        ),
      );

    await traceWriter.append(
      createTraceEvent(sessionId, "final_summary", new Date().toISOString(), {
        summary: withTracePath(executionSummary, traceWriter.tracePath),
        ...(writingArtifact ? { writingArtifact } : {}),
        ...(execution.audit ? { audit: execution.audit } : {}),
      }),
    );
    await traceWriter.append(
      createTraceEvent(
        sessionId,
        "session_finished",
        new Date().toISOString(),
        {
          status: execution.status,
          reason: execution.reason,
          finishedAt: new Date().toISOString(),
        },
      ),
    );
    await emitLiveEvent(input.onLiveEvent, {
      type: "session_finished",
      status: execution.status,
      ...(execution.reason ? { reason: execution.reason } : {}),
    });

    return {
      session,
      summary: withTracePath(executionSummary, traceWriter.tracePath),
      tracePath: traceWriter.tracePath,
      ...(writingArtifact ? { writingArtifact } : {}),
    };
  }

  await traceWriter.append(
    createTraceEvent(sessionId, "final_summary", now, {
      summary: "Execution is scaffolded; no model turn was run.",
    }),
  );
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_finished",
    status: "completed",
  });
  await traceWriter.append(
    createTraceEvent(sessionId, "session_finished", now, {
      status: "completed",
      finishedAt: now,
    }),
  );

  const details = [
    `Forgelet session created: ${sessionId}`,
    `Workflow: ${input.workflow}`,
    ...(input.workflowVariant
      ? [`Workflow variant: ${input.workflowVariant}`]
      : []),
    ...(input.creativeStyle ? [`Creative style: ${input.creativeStyle}`] : []),
    `Task: ${input.task}`,
    `Task hash: ${taskHash}`,
    input.contextFiles.length > 0
      ? `Context attachments: ${input.contextFiles.join(", ")}`
      : "Context attachments: none",
    `Route: ${route.model} (${route.reason})`,
    "Execution: scaffold only; no model turn was run.",
    `Trace: ${traceWriter.tracePath}`,
  ];

  return {
    session,
    summary: details.join("\n"),
    tracePath: traceWriter.tracePath,
  };
};

const modelExecutionFailurePayload = (
  error: unknown,
  tracePath: string,
): { summary: string; error: ReturnType<typeof modelErrorTracePayload> } => {
  const traceError = modelErrorTracePayload(error);
  return {
    summary: withTracePath(
      `Forgelet session failed: ${traceError.message}`,
      tracePath,
    ),
    error: traceError,
  };
};

const modelErrorTracePayload = (
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
    typeof record.causeCategory === "string"
      ? record.causeCategory
      : undefined;
  const phase = typeof record.phase === "string" ? record.phase : undefined;
  const elapsedMs =
    typeof record.elapsedMs === "number" ? record.elapsedMs : undefined;
  const statusCode =
    typeof record.statusCode === "number" ? record.statusCode : undefined;
  const responseBytes =
    typeof record.responseBytes === "number"
      ? record.responseBytes
      : undefined;
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

const hashTask = (task: string): string => {
  const normalized = task.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
};

/**
 * Selects the model and reason for the given workflow and routing decision to
 * determine the route through the workflow graph. The route is used for
 * traceability and to inform the model prompt, but does not affect tool access
 * in this read-only execution mode.
 */
const selectRoute = (
  workflow: WorkflowKind,
  selected: { model: string; reason: string },
): ActLoopRoute => {
  return {
    workflow,
    stage: "act_loop",
    model: selected.model,
    reason: selected.reason,
  };
};

const createTraceEvent = (
  sessionId: string,
  type: string,
  ts: string,
  payload: Record<string, unknown>,
): TraceEvent => {
  return { type, ts, sessionId, payload };
};

const emitLiveEvent = async (
  sink: SessionLiveEventSink | undefined,
  event: SessionLiveEvent,
): Promise<void> => {
  if (sink) await sink(event);
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

/** Runs the core act loop of the workflow graph, where the model generates text
 * and calls tools in a loop until it returns final content with no tool calls, or
 * a budget limit is exceeded. The model can only call tools that are consistent
 * with the workflow's capability grants, and all tool calls are checked and
 * logged by the kernel for traceability and security.
 */
const runReadOnlyLoop = async (
  input: RunReadOnlyLoopInput,
): Promise<RunReadOnlyLoopResult> => {
  const usage: BudgetUsage = {
    modelTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
  const grantedCapabilities = workflowCapabilities(
    input.session.workflow,
    input.act,
  );
  const actionableTools =
    input.act && input.session.workflow === "coding"
      ? createActionableCodingTools({
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
        })
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
  const promptOnlyCreativeBrief =
    input.session.workflowVariant === "creative" &&
    input.contextAttachments.length === 0;
  const tools = promptOnlyCreativeBrief
    ? []
    : toolRegistry.listTools(grantedCapabilities);
  const conversation: ModelMessage[] = [];
  const audit: RunAuditState = {
    changedFiles: new Set(),
    commands: [],
  };
  let finalContent = "";

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

    const remainingModelTurns =
      input.limits.maxModelTurns - usage.modelTurns;
    const finalOnly = remainingModelTurns === 1;
    const finalToolTurn = remainingModelTurns === 2;
    const compaction = compactConversationInPlace(conversation, {
      maxObservationBytes: input.maxObservationBytes,
      observationDigestPreviewBytes: input.observationDigestPreviewBytes,
    });
    if (
      compaction.compactedCount > 0 ||
      compaction.beforeObservationBytes > compaction.targetObservationBytes
    )
      await input.appendTrace(
        compaction.compactedCount > 0
          ? "conversation_compacted"
          : "conversation_compaction_attempted",
        { ...compaction },
      );

    const messages = buildMessages(
      input.session,
      input.plan,
      input.route,
      input.contextAttachments,
      input.durableMemory,
      input.continuationContext,
      usage,
      input.limits,
      conversation,
      input.act,
      compaction.compactedCount > 0
        ? `Active observations compacted: ${compaction.afterObservationBytes}/${compaction.targetObservationBytes} bytes.`
        : undefined,
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
    } catch (error) {
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
      finalContent = normalizeFinalContentForWorkflow(
        input.session,
        output.content ?? "",
        input.contextAttachments.length,
      );
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
  input: RunReadOnlyLoopInput,
  usage: BudgetUsage,
  audit: RunAuditState,
): Promise<SessionAudit> => {
  const finalDirtyPaths = await gitStatusPaths(input.workspaceRoot);
  const forgeletChanged = [...audit.changedFiles].sort();
  const inheritedForgeletChanged = [
    ...new Set(
      input.continuationContext?.priorChangedFiles.flatMap((item) => item.paths) ??
        [],
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

const workflowCapabilities = (
  workflow: WorkflowKind,
  act: boolean,
): Capability[] => {
  if (workflow === "coding")
    return [
      "read_context",
      "read_workspace",
      "git_read",
      "update_plan",
      "model_generate_text",
      ...(act ? (["write_workspace", "run_safe_command"] as const) : []),
    ];
  return ["read_context", "update_plan", "model_generate_text"];
};

const gitStatusPaths = (workspaceRoot: string): Promise<Set<string>> => {
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

const buildMessages = (
  session: AgentSession,
  plan: AgentPlan,
  route: ActLoopRoute,
  contextAttachments: LoadedContextAttachment[],
  durableMemory: LoadedDurableMemory | undefined,
  continuationContext: ContinuationContext | undefined,
  usage: BudgetUsage,
  limits: BudgetLimits,
  conversation: ModelMessage[],
  act: boolean,
  compactionStatus?: string,
  finalOnly = false,
  finalToolTurn = false,
): ModelMessage[] => {
  const contextAttachmentLines =
    formatContextAttachmentsForPrompt(contextAttachments);
  const durableMemoryLines = formatDurableMemoryForPrompt(durableMemory);
  const continuationContextLines =
    formatContinuationContextForPrompt(continuationContext);
  const taskLabel =
    session.workflowVariant === "creative" ? "Creative brief" : "Task";
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: systemPromptFor(
        session,
        act,
        finalOnly,
        contextAttachments.length,
      ),
    },
    {
      role: "user",
      content: [
        `Workflow: ${session.workflow}`,
        ...(session.workflowVariant
          ? [`Workflow variant: ${session.workflowVariant}`]
          : []),
        ...(session.creativeStyle
          ? [`Creative style: ${session.creativeStyle}`]
          : []),
        `Stage: ${route.stage}`,
        `${taskLabel}: ${session.task}`,
        "",
        ...continuationContextLines,
        ...(continuationContextLines.length > 0 ? [""] : []),
        ...contextAttachmentLines,
        ...(contextAttachmentLines.length > 0 ? [""] : []),
        ...durableMemoryLines,
        ...(durableMemoryLines.length > 0 ? [""] : []),
        "Current plan:",
        ...plan.items.map((item) => `- ${item.status}: ${item.step}`),
        "",
        `Budget: ${usage.modelTurns}/${limits.maxModelTurns} model turns, $${usage.estimatedCostUsd.toFixed(4)}/$${limits.maxEstimatedCostUsd.toFixed(4)} estimated.`,
        ...(compactionStatus ? [compactionStatus] : []),
        ...(finalToolTurn
          ? [
              "This is the final tool-capable turn. Request only operations still required to finish.",
            ]
          : []),
        ...(finalOnly
          ? [
              "This is the reserved final answer turn. No tools are available.",
              "Return a non-empty final answer from existing evidence. Do not request tools or emit tool-call syntax.",
            ]
          : []),
      ].join("\n"),
    },
  ];

  messages.push(
    ...(finalOnly
      ? conversationForFinalAnswer(conversation)
      : conversation),
  );
  return messages;
};

const conversationForFinalAnswer = (
  conversation: ModelMessage[],
): ModelMessage[] => {
  const messages: ModelMessage[] = [];
  for (const message of conversation) {
    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: `Earlier tool observation:\n${message.content}`,
      });
      continue;
    }
    if (message.role === "assistant" && message.content.trim()) {
      messages.push({ role: "assistant", content: message.content });
    }
  }
  return messages;
};

const isUsableFinalContent = (content: string): boolean => {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return !trimmed.includes("<｜｜DSML｜｜tool_calls>");
};

const normalizeFinalContentForWorkflow = (
  session: AgentSession,
  content: string,
  contextAttachmentCount = 0,
): string => {
  if (session.workflow !== "writing") return content;
  if (session.workflowVariant === "creative") {
    if (contextAttachmentCount === 0) {
      if (hasMarkdownHeading(content, "Draft")) return content;
      return [
        "Draft",
        content.trim() || "(empty)",
      ].join("\n");
    }
    if (
      hasMarkdownHeading(content, "Critique") &&
      hasMarkdownHeading(content, "Revision") &&
      hasMarkdownHeading(content, "Alternatives") &&
      hasMarkdownHeading(content, "Notes")
    )
      return content;
    return [
      "Critique",
      "No separate critique was provided by the model.",
      "",
      "Revision",
      content.trim() || "(empty)",
      "",
      "Alternatives",
      "1. No vivid/literary alternative was provided by the model.",
      "2. No clearer/tighter alternative was provided by the model.",
      "",
      "Notes",
      "No additional notes were provided.",
    ].join("\n");
  }
  if (
    hasMarkdownHeading(content, "Critique") &&
    hasMarkdownHeading(content, "Revision") &&
    hasMarkdownHeading(content, "Notes")
  )
    return content;
  return [
    "Critique",
    "No separate critique was provided by the model.",
    "",
    "Revision",
    content.trim() || "(empty)",
    "",
    "Notes",
    "No additional notes were provided.",
  ].join("\n");
};

const hasMarkdownHeading = (content: string, heading: string): boolean => {
  return new RegExp(`(^|\\n)#{0,6}\\s*${heading}\\s*(\\n|$)`, "i").test(
    content,
  );
};

const systemPromptFor = (
  session: AgentSession,
  act: boolean,
  finalOnly = false,
  contextAttachmentCount = 0,
): string => {
  const common = [
    "You are running inside the Forgelet Agent Kernel.",
    "Use only the tools provided in this turn.",
    "If a tool call is denied or fails, use the observation to self-correct.",
    "When you can answer the task, return final content with no tool calls.",
    ...(finalOnly
      ? [
          "FINAL ANSWER ONLY: synthesize the best answer from existing evidence.",
          "Do not call or request tools, and do not emit tool-call syntax. If evidence is incomplete, state that limitation in the answer.",
        ]
      : []),
  ];
  if (session.workflow === "coding" && act)
    return [
      ...common,
      "This is an actionable Coding Workflow Session.",
      "You may request apply_patch and run_command only when those tools are provided.",
      "Every file edit or command must pass Forgelet permission and approval boundaries before it runs.",
      "Do not claim verification succeeded unless a run_command observation shows the command ran successfully.",
    ].join("\n");
  if (session.workflow === "coding")
    return [
      ...common,
      "This is a read-only Coding Workflow Session.",
      "Read-only tools may inspect workspace content; do not claim to write files or run commands.",
    ].join("\n");
  if (session.workflowVariant === "creative" && contextAttachmentCount === 0)
    return [
      ...common,
      "This is a Creative Writing Workflow variant.",
      `Style: ${session.creativeStyle ?? "plain"}.`,
      "Use the Creative Brief and Durable Memory for original drafting, but do not request workspace, git, shell, patch, or command tools.",
      "Return only a Draft heading followed by the drafted prose.",
    ].join("\n");
  if (session.workflowVariant === "creative")
    return [
      ...common,
      "This is a Creative Writing Workflow variant.",
      `Style: ${session.creativeStyle ?? "plain"}.`,
      "Use the Creative Brief, any provided Context Attachments, and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
      "If the brief asks for revision but no source text is attached or included, state that limitation and produce the best original draft or useful next step from the brief.",
      "Return a Revision Pack with these headings: Critique, Revision, Alternatives, Notes.",
      "Alternatives must include exactly two options: one more vivid/literary and one clearer/tighter.",
    ].join("\n");
  return [
    ...common,
    "This is a Writing Workflow Session.",
    "Use the provided context and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
    "Return the final answer with these headings: Critique, Revision, Notes.",
  ].join("\n");
};

const formatDurableMemoryForPrompt = (
  durableMemory: LoadedDurableMemory | undefined,
): string[] => {
  if (!durableMemory) return [];
  return [
    "Accepted Durable Memory:",
    `- path: ${durableMemory.path}`,
    `  contentHash: ${durableMemory.contentHash}`,
    `  contentBytes: ${durableMemory.contentBytes}`,
    `  returnedBytes: ${durableMemory.returnedBytes}`,
    `  truncated: ${durableMemory.truncated}`,
    "  content:",
    "  ```",
    indentPromptContent(
      durableMemory.truncated
        ? `${durableMemory.content}\n[truncated: showing ${durableMemory.returnedBytes} of ${durableMemory.contentBytes} bytes]`
        : durableMemory.content,
    ),
    "  ```",
  ];
};

const formatContextAttachmentsForPrompt = (
  attachments: LoadedContextAttachment[],
): string[] => {
  if (attachments.length === 0) return [];

  const lines = ["Context attachments:"];
  let remainingBudget = CONTEXT_ATTACHMENTS_PROMPT_LIMIT_BYTES;

  attachments.forEach(({ attachment, content }) => {
    const contentBytes = Buffer.byteLength(content, "utf8");
    const returnedBytes = Math.min(
      contentBytes,
      CONTEXT_ATTACHMENT_PROMPT_LIMIT_BYTES,
      remainingBudget,
    );
    const rendered = Buffer.from(content, "utf8")
      .subarray(0, returnedBytes)
      .toString("utf8");
    const truncated = returnedBytes < contentBytes;
    remainingBudget -= returnedBytes;

    const attachmentLines = [
      `- id: ${attachment.id}`,
      `  source: ${attachment.source}`,
      `  title: ${attachment.title ?? "(untitled)"}`,
      `  mimeType: ${attachment.mimeType}`,
      `  contentHash: ${attachment.contentHash}`,
      `  contentBytes: ${attachment.contentBytes}`,
      `  returnedBytes: ${returnedBytes}`,
      `  truncated: ${truncated}`,
      "  content:",
      "  ```",
      indentPromptContent(
        truncated
          ? `${rendered}\n[truncated: showing ${returnedBytes} of ${contentBytes} bytes]`
          : rendered,
      ),
      "  ```",
    ];
    if (attachment.uri) attachmentLines.splice(3, 0, `  uri: ${attachment.uri}`);
    lines.push(...attachmentLines);
  });

  return lines;
};

const indentPromptContent = (content: string): string =>
  content
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

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
    ...(session.creativeStyle ? [`Creative style: ${session.creativeStyle}`] : []),
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

const writeWritingArtifact = async (input: {
  workspaceRoot: string;
  session: AgentSession;
  finalContent: string;
  contextAttachmentCount: number;
}): Promise<WritingArtifact> => {
  const contentKind = writingArtifactContentKind(
    input.session,
    input.contextAttachmentCount,
  );
  const heading = contentKind === "draft" ? "Draft" : "Revision";
  const body =
    (extractKnownWritingSection(input.finalContent, heading) ??
      input.finalContent.trim()) ||
    "(empty)";
  const content = ensureTrailingNewline(body);
  const artifactDir = join(input.workspaceRoot, ".forgelet", "writing");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = join(
    artifactDir,
    `${slugTaskForFilename(input.session.task)}-${input.session.id}.md`,
  );
  await writeFile(artifactPath, content, "utf8");
  return {
    path: relative(input.workspaceRoot, artifactPath),
    contentKind,
    contentBytes: Buffer.byteLength(content, "utf8"),
  };
};

const writingArtifactContentKind = (
  session: AgentSession,
  contextAttachmentCount: number,
): WritingArtifact["contentKind"] => {
  if (session.workflowVariant === "creative" && contextAttachmentCount === 0)
    return "draft";
  return "revision";
};

const KNOWN_WRITING_HEADINGS = new Set([
  "draft",
  "critique",
  "revision",
  "alternatives",
  "notes",
]);

const extractKnownWritingSection = (
  content: string,
  heading: "Draft" | "Revision",
): string | undefined => {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex(
    (line) => normalizeWritingHeading(line) === heading.toLowerCase(),
  );
  if (startIndex === -1) return undefined;
  const endIndex = lines.findIndex(
    (line, index) =>
      index > startIndex &&
      KNOWN_WRITING_HEADINGS.has(normalizeWritingHeading(line)),
  );
  return lines
    .slice(startIndex + 1, endIndex === -1 ? lines.length : endIndex)
    .join("\n")
    .trim();
};

const normalizeWritingHeading = (line: string): string =>
  line
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .toLowerCase();

const slugTaskForFilename = (task: string): string => {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "writing";
};

const ensureTrailingNewline = (content: string): string =>
  content.endsWith("\n") ? content : `${content}\n`;

const appendWritingArtifactLine = (
  summary: string,
  artifact: WritingArtifact,
): string =>
  [
    summary,
    `Writing artifact: ${artifact.path} (${artifact.contentKind}, ${artifact.contentBytes} bytes)`,
  ].join("\n");

const withTracePath = (summary: string, tracePath: string): string => {
  return summary.includes("\nTrace: ")
    ? summary
    : [summary, `Trace: ${tracePath}`].join("\n");
};

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
