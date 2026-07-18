import type {
  AgentPlan,
  AgentSession,
  BudgetLimits,
  LoadedContextAttachment,
  ModelClient,
  SessionFinishStatus,
  WorkflowKind,
} from "../types.js";
import { createHash } from "node:crypto";
import { relative } from "node:path";
import { browserSnapshotToContextAttachment } from "../browser/index.js";
import {
  createSessionSourceLedger,
  type SessionSourceLedgerView,
} from "../sourceLedger/index.js";
import { loadConfig, routeModel } from "../config/index.js";
import { maxConversationBytesForRoute } from "../models/routing.js";
import { hasDeepSeekStaticPricing } from "../models/providers/deepseek.js";
import { loadDurableMemory } from "../memory/index.js";
import {
  createDebugTranscriptWriter,
  summarizeDebugTranscriptFile,
  type DebugTranscriptWriter,
} from "../debugTranscript/index.js";
import {
  createEnvelopeApprovalHandler,
  widenEnvelopeForRequest,
  type EffectEnvelope,
} from "../permissions/envelope.js";
import { normalizeSessionReadScope } from "../readScope/index.js";
import type {
  SessionLiveEvent,
  SessionLiveEventSink,
} from "../sessionLiveView/index.js";
import {
  buildContinuationContext,
  continuationContextTracePayload,
} from "../sessions/continuation.js";
import {
  deletePauseSnapshot,
  pauseSnapshotPath,
  readPauseSnapshot,
  writePauseSnapshot,
  type PauseSnapshot,
} from "../sessions/pauseSnapshot.js";
import { removePidMarker, writePidMarker } from "../sessions/pidMarker.js";
import {
  createTraceWriter,
  findSessionTracePath,
  openExistingTraceWriter,
  type KnownTraceEvent,
  type TraceEventPayloads,
  type TraceEventType,
  type TraceWriter,
} from "../trace/index.js";
import type {
  CompletionEffects,
  KernelSessionResult,
  RunKernelSessionInput,
  WorkflowDefinition,
} from "./workflowDefinition.js";
import {
  gitStatusPaths,
  modelErrorTracePayload,
  runReactNode,
  type ActLoopRoute,
  type ReactNodeFinishResult,
  type ReactNodeInput,
  type ReactNodePausedResult,
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

  if (input.signal?.aborted)
    throw new Error("Session launch cancelled before Session creation.");

  // Launch preflight: every step below must complete before any Trace file,
  // PID marker, or live event is created, so a rejected launch leaves no
  // Session evidence behind (ADR 0036/WP2).
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
  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const baselineDirtyPaths = input.act
    ? await gitStatusPaths(input.workspaceRoot)
    : new Set<string>();
  const sourceLedger = createSessionSourceLedger({
    workspaceRoot: input.workspaceRoot,
    sessionId,
  });
  if (
    input.definition.capabilities({ act: input.act === true, readScope }).includes("read_public_web") &&
    !input.publicWeb
  )
    throw new Error("Public Web adapters are required when read_public_web is granted.");
  const attachmentPlan = await input.definition.loadAttachments({
    workspaceRoot: input.workspaceRoot,
    contextFiles: input.contextFiles,
    sourceLedger,
  });
  if (input.browserSnapshot)
    browserSnapshotToContextAttachment(input.browserSnapshot, sourceLedger);
  const allLoadedContextAttachments = [
    ...sourceLedger.view.contextAttachments(),
  ];
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
  warnForUnpricedModel(route.model);
  const plan: AgentPlan = {
    items: [
      { step: "Create session and load task context", status: "completed" },
      { step: "Run workflow graph with model and tools", status: "pending" },
    ],
  };

  const session: AgentSession = {
    id: sessionId,
    workflow: input.definition.kind,
    ...sessionTraitFields(input.definition.sessionTraits),
    task: input.task,
    taskHash,
    ...(readScope ? { readScope } : {}),
    stage: "final",
    plan,
    createdAt: now,
  };

  // Preflight complete; the launch is authorized. Create identity evidence.
  await writePidMarker(input.workspaceRoot, sessionId);
  const traceWriter = await createTraceWriter(input.workspaceRoot, sessionId, {
    createdAt: startedAt,
  });

  await traceWriter.append(
    createTraceEvent(sessionId, "session_started", now, {
      workflow: input.definition.kind,
      ...sessionTraitFields(input.definition.sessionTraits),
      ...(input.definition.sessionTraits?.startTraceExtras ?? {}),
      startedAt: now,
      taskHash,
      executionPolicy: input.executionPolicy ?? "iterative",
      ...(readScope ? { readScope } : {}),
      ...(input.envelope ? { envelope: input.envelope } : {}),
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
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_started",
    workflow: input.definition.kind,
    task: input.task,
  });
  await emitLiveEvent(input.onLiveEvent, {
    type: "trace_path",
    tracePath: traceWriter.tracePath,
  });
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
        { ...contextAttachment.attachment },
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

  // Session identity is now stable and Trace-backed; publish it before any
  // model-turn live event so callers never infer identity from a filename.
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_ready",
    sessionId,
    tracePath: traceWriter.tracePath,
  });

  const limits = {
    ...config.budgets,
    maxEstimatedCostUsd: input.budgetUsd ?? config.budgets.maxEstimatedCostUsd,
    maxWallClockMs: input.maxWallClockMs ?? config.budgets.maxWallClockMs,
    maxModelTurns: input.maxModelTurns ?? config.budgets.maxModelTurns,
  };

  // Deterministic low-level tests may omit a model client. Public CLI runs pass
  // a model client and do not use this branch.
  if (input.modelClient) {
    return settleExecution({
      loop: {
        modelClient: input.modelClient,
        session,
        continuationAttachment,
        contextAttachments,
        sourceLedger,
        publicWeb: input.publicWeb,
        durableMemory,
        workspaceRoot: input.workspaceRoot,
        route,
        plan,
        limits,
        ...loopConfigFor(config, input.definition.kind),
        readScope,
        act: input.act === true,
        baselineDirtyPaths,
        tracePath: traceWriter.tracePath,
        continuationContext,
        executionPolicy: input.executionPolicy,
        signal: input.signal,
        definition: input.definition,
        approvalHandler: input.envelope
          ? createEnvelopeApprovalHandler(input.envelope)
          : input.approvalHandler,
        now: input.now,
        onLiveEvent: input.onLiveEvent,
        debugTranscript,
      },
      traceWriter,
      envelope: input.envelope,
    });
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

  await removePidMarker(input.workspaceRoot, sessionId);
  return {
    session,
    summary: details.join("\n"),
    tracePath: traceWriter.tracePath,
  };
};

const unpricedModelWarnings = new Set<string>();

function warnForUnpricedModel(model: string): void {
  if (
    !model.startsWith("deepseek-") ||
    hasDeepSeekStaticPricing(model) ||
    unpricedModelWarnings.has(model)
  )
    return;
  unpricedModelWarnings.add(model);
  process.stderr.write(
    `Warning: ${model} has no static DeepSeek pricing; estimated cost may be incomplete.\n`,
  );
}

export type ResumeDecision =
  | { kind: "approve" }
  | { kind: "deny" }
  | { kind: "widen" }
  | { kind: "stop" };

export interface ResumeKernelSessionInput<TCompletion = void> {
  definition: WorkflowDefinition<TCompletion>;
  workspaceRoot: string;
  sessionId: string;
  modelClient: ModelClient;
  decision: ResumeDecision;
  homeDir?: string;
  /** Injectable clock for deterministic wall-clock budget tests; defaults to Date.now. */
  now?: () => number;
  onLiveEvent?: SessionLiveEventSink;
}

/**
 * Resumes a paused Session in place: the same Session id, the same Trace,
 * continuing from exactly where the pending confirm-tier action interrupted
 * it (ADR 0027). approve-and-widen amends the declared Effect Envelope in
 * memory (traced separately) before the pending call is retried through the
 * normal envelope-approval path, so it — and any now-in-scope sibling calls
 * in the same batch — auto-approve.
 */
export async function resumeKernelSession<TCompletion = void>(
  input: ResumeKernelSessionInput<TCompletion>,
): Promise<KernelSessionResult<TCompletion>> {
  const snapshot = await readPauseSnapshot(input.workspaceRoot, input.sessionId);
  await writePidMarker(input.workspaceRoot, snapshot.sessionId);
  const tracePath = await findSessionTracePath(input.workspaceRoot, input.sessionId);
  const traceWriter = openExistingTraceWriter(tracePath);
  const resumedAt = new Date().toISOString();
  await traceWriter.append(
    createTraceEvent(snapshot.sessionId, "session_resumed", resumedAt, {
      decision: input.decision.kind,
    }),
  );

  let effectiveEnvelope = snapshot.envelope;
  if (input.decision.kind === "widen") {
    const widened = widenEnvelopeForRequest(
      snapshot.envelope,
      snapshot.working.pendingToolRequest,
    );
    await traceWriter.append(
      createTraceEvent(snapshot.sessionId, "envelope_amended", resumedAt, {
        before: snapshot.envelope,
        after: widened,
      }),
    );
    effectiveEnvelope = widened;
  }

  const session: AgentSession = {
    id: snapshot.sessionId,
    workflow: snapshot.workflow,
    ...sessionTraitFields(snapshot),
    task: snapshot.task,
    taskHash: snapshot.taskHash,
    ...(snapshot.readScope ? { readScope: snapshot.readScope } : {}),
    stage: "act_loop",
    plan: snapshot.plan,
    createdAt: snapshot.createdAt,
  };

  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const debugTranscript = snapshot.debug
    ? await createDebugTranscriptWriter(input.workspaceRoot, snapshot.sessionId)
    : undefined;
  const decisionKind: "approve" | "deny" | "stop" =
    input.decision.kind === "widen" ? "approve" : input.decision.kind;

  return settleExecution({
    loop: {
      modelClient: input.modelClient,
      session,
      // Deliberate: restored conversation already carries the active Session context.
      contextAttachments: [],
      durableMemory: undefined,
      continuationContext: undefined,
      // Unaudited: resume has no restoration path for these fresh-only inputs.
      continuationAttachment: undefined,
      sourceLedger: undefined,
      publicWeb: undefined,
      executionPolicy: undefined,
      signal: undefined,
      approvalHandler: undefined,
      workspaceRoot: input.workspaceRoot,
      route: snapshot.route,
      plan: snapshot.plan,
      limits: snapshot.limits,
      ...loopConfigFor(config, snapshot.workflow),
      readScope: snapshot.readScope,
      act: true,
      baselineDirtyPaths: snapshot.working.sessionState.baselineDirtyPaths,
      tracePath: traceWriter.tracePath,
      definition: input.definition,
      envelope: effectiveEnvelope,
      resume: {
        decision: decisionKind,
        working: snapshot.working,
      },
      now: input.now,
      onLiveEvent: input.onLiveEvent,
      debugTranscript,
    },
    traceWriter,
    envelope: effectiveEnvelope,
  });
}

/**
 * Settles one bounded ReAct Node into exactly one Session outcome: finalized,
 * paused, or failed with Trace evidence. Public Session entry points only
 * assemble loop input; this keeps ADR 0025's kernel seam intact.
 */
async function settleExecution<TCompletion>(input: {
  loop: Omit<ReactNodeInput, "appendTrace"> & {
    definition: WorkflowDefinition<TCompletion>;
  };
  traceWriter: TraceWriter;
  envelope?: EffectEnvelope;
}): Promise<KernelSessionResult<TCompletion>> {
  const { loop, traceWriter, envelope } = input;
  const { session, workspaceRoot } = loop;
  let execution: ReactNodeResult;
  try {
    execution = await runReactNode({
      ...loop,
      appendTrace: (type, payload, ts) =>
        traceWriter.append(
          createTraceEvent(
            session.id,
            type,
            ts ?? new Date().toISOString(),
            payload,
          ),
        ),
    });
  } catch (error) {
    const failure = modelExecutionFailurePayload(error, traceWriter.tracePath);
    if (loop.debugTranscript)
      await finishDebugTranscript({
        writer: loop.debugTranscript,
        sessionId: session.id,
        workspaceRoot,
        status: "failed",
        appendTrace: (payload) =>
          traceWriter.append(
            createTraceEvent(
              session.id,
              "debug_transcript_finished",
              new Date().toISOString(),
              payload,
            ),
          ),
      });
    const reason = typedFailureReason(error) ?? "model_execution_error";
    if (loop.resume) {
      // A crashed resume attempt is attempt evidence, not a terminal outcome:
      // the pause stays in force and the snapshot survives for retry, so
      // final_summary and session_finished keep their literal meaning (ADR 0061).
      await traceWriter.append(
        createTraceEvent(
          session.id,
          "session_resume_failed",
          new Date().toISOString(),
          {
            reason,
            error: failure.error,
            summary: failure.summary,
            failedAt: new Date().toISOString(),
          },
        ),
      );
      await emitLiveEvent(loop.onLiveEvent, {
        type: "session_resume_failed",
        sessionId: session.id,
        reason,
      });
    } else {
      await traceWriter.append(
        createTraceEvent(session.id, "final_summary", new Date().toISOString(), {
          summary: failure.summary,
          error: failure.error,
        }),
      );
      await traceWriter.append(
        createTraceEvent(
          session.id,
          "session_finished",
          new Date().toISOString(),
          {
            status: "failed",
            reason,
            error: failure.error,
            finishedAt: new Date().toISOString(),
          },
        ),
      );
      await emitLiveEvent(loop.onLiveEvent, {
        type: "session_finished",
        status: "failed",
        reason,
      });
    }
    await removePidMarker(workspaceRoot, session.id);
    throw error;
  }

  // A crashed resume retains its Pause Snapshot for retry; every non-crashing
  // outcome replaces or clears it after reaching this point (ADR 0033).
  if (loop.resume) await deletePauseSnapshot(workspaceRoot, session.id);

  if (execution.status === "paused") {
    if (!envelope)
      throw new Error(
        `Session paused without a declared Effect Envelope: ${session.id}.`,
      );
    return pauseKernelExecution({
      sessionId: session.id,
      session,
      execution,
      definition: loop.definition,
      workspaceRoot,
      task: session.task,
      taskHash: session.taskHash,
      createdAt: session.createdAt,
      envelope,
      route: loop.route,
      readScope: loop.readScope,
      plan: loop.plan,
      limits: loop.limits,
      debug: loop.debugTranscript !== undefined,
      traceWriter,
      onLiveEvent: loop.onLiveEvent,
    });
  }

  return finalizeKernelExecution({
    sessionId: session.id,
    session,
    execution,
    definition: loop.definition,
    contextAttachments: loop.contextAttachments,
    sourceLedger: loop.sourceLedger?.view,
    workspaceRoot,
    traceWriter,
    debugTranscript: loop.debugTranscript,
    onLiveEvent: loop.onLiveEvent,
  });
}

async function finalizeKernelExecution<TCompletion>(input: {
  sessionId: string;
  session: AgentSession;
  execution: ReactNodeFinishResult;
  definition: WorkflowDefinition<TCompletion>;
  contextAttachments: LoadedContextAttachment[];
  sourceLedger?: SessionSourceLedgerView;
  workspaceRoot: string;
  traceWriter: TraceWriter;
  debugTranscript?: DebugTranscriptWriter;
  onLiveEvent?: SessionLiveEventSink;
}): Promise<KernelSessionResult<TCompletion>> {
  const {
    sessionId,
    session,
    execution,
    definition,
    contextAttachments,
    sourceLedger,
    workspaceRoot,
    traceWriter,
    debugTranscript,
  } = input;
  let completionEffects: CompletionEffects<TCompletion> | undefined;
  if (execution.status === "completed" && execution.finalContent)
    completionEffects = await definition.onCompleted?.({
      workspaceRoot,
      session,
      finalContent: execution.finalContent,
      contextAttachments,
      sourceLedger,
      appendTrace: (type, payload) =>
        traceWriter.append(
          createTraceEvent(sessionId, type, new Date().toISOString(), payload),
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
      workspaceRoot,
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
    createTraceEvent(sessionId, "session_finished", new Date().toISOString(), {
      status: execution.status,
      reason: execution.reason,
      finishedAt: new Date().toISOString(),
    }),
  );
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_finished",
    status: execution.status,
    ...(execution.reason ? { reason: execution.reason } : {}),
  });
  await removePidMarker(workspaceRoot, sessionId);

  return {
    session,
    summary: withTracePath(executionSummary, traceWriter.tracePath),
    tracePath: traceWriter.tracePath,
    ...(completionEffects?.completion !== undefined
      ? { completion: completionEffects.completion }
      : {}),
  };
}

async function pauseKernelExecution<TCompletion>(input: {
  sessionId: string;
  session: AgentSession;
  execution: ReactNodePausedResult;
  definition: WorkflowDefinition<TCompletion>;
  workspaceRoot: string;
  task: string;
  taskHash: string;
  createdAt: string;
  envelope: EffectEnvelope;
  route: ActLoopRoute;
  readScope?: string[];
  plan: AgentPlan;
  limits: BudgetLimits;
  debug: boolean;
  traceWriter: TraceWriter;
  onLiveEvent?: SessionLiveEventSink;
}): Promise<KernelSessionResult<TCompletion>> {
  const { sessionId, session, execution, definition, traceWriter } = input;
  const pausedAt = new Date().toISOString();
  const snapshot: PauseSnapshot = {
    sessionId,
    workflow: definition.kind,
    ...sessionTraitFields(definition.sessionTraits),
    task: input.task,
    taskHash: input.taskHash,
    createdAt: input.createdAt,
    envelope: input.envelope,
    route: input.route,
    ...(input.readScope ? { readScope: input.readScope } : {}),
    plan: input.plan,
    limits: input.limits,
    debug: input.debug,
    working: execution.working,
    tracePath: traceWriter.tracePath,
    pausedAt,
  };
  await writePauseSnapshot(input.workspaceRoot, snapshot);
  const snapshotPath = pauseSnapshotPath(input.workspaceRoot, sessionId);
  await traceWriter.append(
    createTraceEvent(sessionId, "session_paused", pausedAt, {
      reason: "out_of_envelope",
      toolName: execution.working.pendingToolCall.name,
      targets: execution.working.pendingToolRequest.targets,
      snapshotPath,
    }),
  );
  await emitLiveEvent(input.onLiveEvent, {
    type: "session_paused",
    sessionId,
  });
  await removePidMarker(input.workspaceRoot, sessionId);
  return {
    session,
    summary: `Forgelet session paused: ${sessionId}\nRun \`forge decide ${sessionId}\` to review the pending action.`,
    tracePath: traceWriter.tracePath,
    status: "paused",
    snapshotPath,
  };
}

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

/** Workflow-level validation failures (e.g. Page Answer Evidence rejection)
 * throw an Error carrying a stable string `reason`; this lets the Session
 * finish with that typed reason instead of the generic model-execution one,
 * without a workflow needing kernel-private trace-writing access. */
const typedFailureReason = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const reason = (error as Record<string, unknown>).reason;
  return typeof reason === "string" ? reason : undefined;
};

const hashTask = (task: string): string => {
  const normalized = task.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
};

const sessionTraitFields = (
  traits: WorkflowDefinition<unknown>["sessionTraits"],
) => ({
  ...(traits?.workflowVariant ? { workflowVariant: traits.workflowVariant } : {}),
  ...(traits?.creativeStyle ? { creativeStyle: traits.creativeStyle } : {}),
  ...(traits?.creativeInputKind
    ? { creativeInputKind: traits.creativeInputKind }
    : {}),
});

const loopConfigFor = (
  config: Awaited<ReturnType<typeof loadConfig>>,
  workflow: WorkflowKind,
) => ({
  actionableTools: {
    safeCommands: config.safeCommands,
    commandTimeoutMs: config.commandTimeoutMs,
    maxPatchBytes: config.maxPatchBytes,
  },
  activeContext: {
    ...config.activeContext,
    maxConversationBytes: maxConversationBytesForRoute(config, workflow),
  },
});

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

const createTraceEvent = <Type extends TraceEventType>(
  sessionId: string,
  type: Type,
  ts: string,
  payload: TraceEventPayloads[Type],
): Extract<KnownTraceEvent, { type: Type }> => {
  return { type, ts, sessionId, payload } as Extract<KnownTraceEvent, { type: Type }>;
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
  appendTrace(payload: TraceEventPayloads["debug_transcript_finished"]): Promise<void>;
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
