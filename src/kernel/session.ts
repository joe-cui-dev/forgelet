import type {
  AgentPlan,
  AgentSession,
  SessionFinishStatus,
  TraceEvent,
  WorkflowKind,
} from "../types.js";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { browserSnapshotToContextAttachment } from "../browser/index.js";
import { loadConfig, routeModel } from "../config/index.js";
import { maxConversationBytesForRoute } from "../models/routing.js";
import { loadDurableMemory } from "../memory/index.js";
import {
  createDebugTranscriptWriter,
  summarizeDebugTranscriptFile,
  type DebugTranscriptWriter,
} from "../debugTranscript/index.js";
import { normalizeSessionReadScope } from "../readScope/index.js";
import type {
  SessionLiveEvent,
  SessionLiveEventSink,
} from "../sessionLiveView/index.js";
import {
  buildContinuationContext,
  continuationContextTracePayload,
} from "../sessions/continuation.js";
import { createTraceWriter } from "../trace/index.js";
import type {
  CompletionEffects,
  KernelSessionResult,
  RunKernelSessionInput,
} from "./workflowDefinition.js";
import {
  gitStatusPaths,
  modelErrorTracePayload,
  runReactNode,
  type ActLoopRoute,
  type ReactNodeResult,
} from "./reactNode.js";

/**
 * Runs a Forgelet workflow session with the given input, returning the final
 * session state and a human-readable summary. The model can call only the tools
 * granted to its workflow; completion artifacts are produced by Forgelet after the
 * model returns final content.
 */
export async function runKernelSession<TCompletion = void>(
  input: RunKernelSessionInput<TCompletion>,
): Promise<KernelSessionResult<TCompletion>> {
  const startedAt = new Date();
  const now = startedAt.toISOString();
  const sessionId = `sess_${startedAt.getTime().toString(36)}`;
  const taskHash = hashTask(input.task);
  const continuationContext = input.continuationSourceSessionId
    ? await buildContinuationContext(
        input.workspaceRoot,
        input.continuationSourceSessionId,
      )
    : undefined;
  const readScope = await normalizeSessionReadScope(
    input.workspaceRoot,
    input.readScopeRequest ?? continuationContext?.inheritedReadScope,
  );
  const traceWriter = await createTraceWriter(input.workspaceRoot, sessionId, {
    createdAt: startedAt,
  });
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_started",
    workflow: input.definition.kind,
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
  const baselineDirtyPaths = input.act
    ? await gitStatusPaths(input.workspaceRoot)
    : new Set<string>();
  const attachmentPlan = await input.definition.loadAttachments({
    workspaceRoot: input.workspaceRoot,
    contextFiles: input.contextFiles,
  });
  const loadedContextAttachments = [
    ...(attachmentPlan.continuationAttachment
      ? [attachmentPlan.continuationAttachment]
      : []),
    ...attachmentPlan.contextAttachments,
  ];
  const allLoadedContextAttachments = input.browserSnapshot
    ? [
        ...loadedContextAttachments,
        browserSnapshotToContextAttachment(
          input.browserSnapshot,
          `ctx_${loadedContextAttachments.length + 1}`,
        ),
      ]
    : loadedContextAttachments;
  const continuationAttachment = attachmentPlan.continuationAttachment;
  const contextAttachments = attachmentPlan.continuationAttachment
    ? allLoadedContextAttachments.slice(1)
    : allLoadedContextAttachments;
  const durableMemory = input.modelClient
    ? await loadDurableMemory(input.workspaceRoot)
    : undefined;
  const route = selectRoute(
    input.definition.kind,
    routeModel(config, input.definition.kind, input.model),
  );
  const plan: AgentPlan = {
    items: [
      { step: "Create session and load task context", status: "completed" },
      { step: "Run workflow graph with model and tools", status: "pending" },
    ],
  };

  const session: AgentSession = {
    id: sessionId,
    workflow: input.definition.kind,
    ...(input.definition.sessionTraits?.workflowVariant
      ? { workflowVariant: input.definition.sessionTraits.workflowVariant }
      : {}),
    ...(input.definition.sessionTraits?.creativeStyle
      ? { creativeStyle: input.definition.sessionTraits.creativeStyle }
      : {}),
    ...(input.definition.sessionTraits?.creativeInputKind
      ? { creativeInputKind: input.definition.sessionTraits.creativeInputKind }
      : {}),
    task: input.task,
    taskHash,
    ...(readScope ? { readScope } : {}),
    stage: "final",
    plan,
    createdAt: now,
  };

  await traceWriter.append(
    createTraceEvent(sessionId, "session_started", now, {
      workflow: input.definition.kind,
      ...(input.definition.sessionTraits?.workflowVariant
        ? { workflowVariant: input.definition.sessionTraits.workflowVariant }
        : {}),
      ...(input.definition.sessionTraits?.creativeStyle
        ? { creativeStyle: input.definition.sessionTraits.creativeStyle }
        : {}),
      ...(input.definition.sessionTraits?.creativeInputKind
        ? { creativeInputKind: input.definition.sessionTraits.creativeInputKind }
        : {}),
      ...(input.definition.sessionTraits?.startTraceExtras ?? {}),
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
        inheritedWorkflow: input.definition.kind,
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
  for (const contextAttachment of allLoadedContextAttachments) {
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
  if (input.act)
    await traceWriter.append(
      createTraceEvent(sessionId, "workspace_baseline", now, {
        dirtyPaths: [...baselineDirtyPaths],
      }),
    );
  await traceWriter.append(
    createTraceEvent(sessionId, "plan_update", now, { plan }),
  );
  const debugTranscript = input.debug
    ? await createDebugTranscriptWriter(input.workspaceRoot, sessionId)
    : undefined;
  if (debugTranscript)
    await traceWriter.append(
      createTraceEvent(sessionId, "debug_transcript_started", now, {
        path: relative(input.workspaceRoot, debugTranscript.path),
      }),
    );

  // Deterministic low-level tests may omit a model client. Public CLI runs pass
  // a model client and do not use this branch.
  if (input.modelClient) {
    let execution: ReactNodeResult;
    try {
      execution = await runReactNode({
        modelClient: input.modelClient,
        session,
        continuationAttachment,
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
        maxConversationBytes: maxConversationBytesForRoute(
          config,
          input.definition.kind,
        ),
        observationDigestPreviewBytes:
          config.activeContext.observationDigestPreviewBytes,
        protectedRecentTurns: config.activeContext.protectedRecentTurns,
        readScope,
        act: input.act === true,
        baselineDirtyPaths,
        tracePath: traceWriter.tracePath,
        continuationContext,
        definition: input.definition,
        approvalHandler: input.approvalHandler,
        onLiveEvent: input.onLiveEvent,
        debugTranscript,
        appendTrace: (type, payload, ts) =>
          traceWriter.append(
            createTraceEvent(
              sessionId,
              type,
              ts ?? new Date().toISOString(),
              payload,
            ),
          ),
      });
    } catch (error) {
      const failure = modelExecutionFailurePayload(
        error,
        traceWriter.tracePath,
      );
      if (debugTranscript)
        await finishDebugTranscript({
          writer: debugTranscript,
          sessionId,
          workspaceRoot: input.workspaceRoot,
          status: "failed",
          appendTrace: (payload) =>
            traceWriter.append(
              createTraceEvent(
                sessionId,
                "debug_transcript_finished",
                new Date().toISOString(),
                payload,
              ),
            ),
        });
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

    let completionEffects: CompletionEffects<TCompletion> | undefined;
    if (execution.status === "completed" && execution.finalContent)
      completionEffects = await input.definition.onCompleted?.({
        workspaceRoot: input.workspaceRoot,
        session,
        finalContent: execution.finalContent,
        contextAttachments,
        appendTrace: (type, payload) =>
          traceWriter.append(
            createTraceEvent(
              sessionId,
              type,
              new Date().toISOString(),
              payload,
            ),
          ),
      });
    const executionSummary = [
      execution.summary,
      ...(completionEffects?.summaryLines ?? []),
    ].join("\n");

    if (debugTranscript)
      await finishDebugTranscript({
        writer: debugTranscript,
        sessionId,
        workspaceRoot: input.workspaceRoot,
        status: execution.status,
        ...(execution.reason ? { reason: execution.reason } : {}),
        appendTrace: (payload) =>
          traceWriter.append(
            createTraceEvent(
              sessionId,
              "debug_transcript_finished",
              new Date().toISOString(),
              payload,
            ),
          ),
      });

    await traceWriter.append(
      createTraceEvent(sessionId, "final_summary", new Date().toISOString(), {
        summary: withTracePath(executionSummary, traceWriter.tracePath),
        ...(completionEffects?.finalSummaryTraceExtras ?? {}),
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
      ...(completionEffects?.completion !== undefined
        ? { completion: completionEffects.completion }
        : {}),
    };
  }

  await traceWriter.append(
    createTraceEvent(sessionId, "final_summary", now, {
      summary:
        "Execution used deterministic test seam; model client was omitted.",
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
    `Workflow: ${input.definition.kind}`,
    ...(input.definition.sessionTraits?.workflowVariant
      ? [`Workflow variant: ${input.definition.sessionTraits.workflowVariant}`]
      : []),
    ...(input.definition.sessionTraits?.creativeStyle
      ? [`Creative style: ${input.definition.sessionTraits.creativeStyle}`]
      : []),
    `Task: ${input.task}`,
    `Task hash: ${taskHash}`,
    input.contextFiles.length > 0
      ? `Context attachments: ${input.contextFiles.join(", ")}`
      : "Context attachments: none",
    `Route: ${route.model} (${route.reason})`,
    "Execution: deterministic test seam; model client was omitted.",
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

const finishDebugTranscript = async (input: {
  writer: DebugTranscriptWriter;
  sessionId: string;
  workspaceRoot: string;
  status: SessionFinishStatus;
  reason?: string;
  appendTrace(payload: Record<string, unknown>): Promise<void>;
}): Promise<void> => {
  await input.writer.append({
    type: "session_debug_finished",
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    payload: {
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  const summary = await summarizeDebugTranscriptFile(input.writer.path);
  await input.appendTrace({
    path: relative(input.workspaceRoot, input.writer.path),
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    ...summary,
  });
};

const withTracePath = (summary: string, tracePath: string): string => {
  return summary.includes("\nTrace: ")
    ? summary
    : [summary, `Trace: ${tracePath}`].join("\n");
};
