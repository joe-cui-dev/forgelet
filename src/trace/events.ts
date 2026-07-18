import type {
  AgentPlan,
  BudgetLimits,
  BudgetUsage,
  Capability,
  ContextAttachment,
  ModelUsage,
  RiskTier,
  SessionAudit,
  SessionFinishStatus,
  WorkflowKind,
} from "../types.js";
import type { ObservationMetadata, ToolObservation } from "../observation/index.js";

/**
 * The complete, additive vocabulary for Session Trace evidence. Fields stay
 * optional when historical Trace files may predate them; producers still use
 * this map as their checked payload contract.
 */
export interface TraceEventPayloads {
  session_started: {
    workflow?: WorkflowKind;
    workflowVariant?: "creative";
    creativeStyle?: string;
    creativeInputKind?: "draft" | "revision" | "continuation";
    startedAt?: string;
    taskHash?: string;
    executionPolicy?: "iterative" | "answer_once";
    readScope?: string[];
    envelope?: { writeScopePrefixes: string[]; allowedCommands: string[] };
    continuation?: {
      sourceSessionId: string;
      rootSessionId: string;
      lineageSessionIds: string[];
      degraded: boolean;
    };
    projectSlug?: string;
    deliverableShape?: "learningPack" | "pageBrief" | "pageAnswer";
    trigger?: {
      kind: "root" | "root_retry" | "follow_up" | "follow_up_retry";
      conversationId: string;
      actionId: string;
      invocationId: string;
      workspaceProfileId: string;
      captureId: string;
      captureReadyMs?: number;
      rootSessionId?: string;
      parentSessionId?: string;
      outputLanguage?: string;
    };
  };
  user_task: { task?: string };
  session_continuation_started: {
    sourceSessionId?: string;
    lineageSessionIds?: string[];
    lineageDepth?: number;
    degraded?: boolean;
    incompleteReasons?: string[];
    inheritedWorkflow?: WorkflowKind;
    inheritedReadScope?: string[];
  };
  continuation_context_loaded: {
    summaries?: number;
    contextAttachments?: number;
    inheritedReadScope?: string[];
    sourceStatus?: SessionFinishStatus | "incomplete";
    degraded?: boolean;
    priorChangedFiles?: number;
    priorVerificationCommands?: number;
    priorRisks?: number;
    inheritedChangedPaths?: string[];
  };
  context_attachment: ContextAttachment & {
    url?: string;
    finalUrl?: string;
    canonicalUrl?: string;
    toolCallId?: string;
    durationMs?: number;
  } & Record<string, unknown>;
  memory_loaded: {
    path?: string;
    contentBytes?: number;
    returnedBytes?: number;
    contentHash?: string;
    preview?: string;
    truncated?: boolean;
  };
  routing_selected: {
    workflow?: WorkflowKind;
    stage?: "act_loop";
    model?: string;
    reason?: string;
  };
  workspace_baseline: { dirtyPaths?: string[] };
  plan_update: { plan?: AgentPlan };
  debug_transcript_started: { path?: string };
  debug_transcript_finished: {
    path?: string;
    status?: SessionFinishStatus;
    reason?: string;
    contentHash?: string;
    contentBytes?: number;
  };
  final_summary: {
    summary?: string;
    error?: unknown;
    audit?: SessionAudit;
    writingArtifact?: TraceWritingArtifact;
    finalContent?: string;
  };
  session_finished: {
    status?: SessionFinishStatus;
    reason?: string;
    error?: unknown;
    finishedAt?: string;
  };
  session_resumed: { decision?: "approve" | "deny" | "widen" | "stop" };
  envelope_amended: {
    before?: { writeScopePrefixes: string[]; allowedCommands: string[] };
    after?: { writeScopePrefixes: string[]; allowedCommands: string[] };
  };
  session_paused: {
    reason?: "out_of_envelope";
    toolName?: string;
    targets?: unknown[];
    snapshotPath?: string;
  };
  budget_wrapup_triggered: {
    turnIndex?: number;
    reason?: string;
    usage?: BudgetUsage;
    limits?: BudgetLimits;
    reserveFraction?: number;
    elapsedWallClockMs?: number;
  };
  conversation_compacted: ConversationCompactionPayload;
  conversation_compaction_attempted: ConversationCompactionPayload;
  conversation_fold_stopped: {
    protectedRecentTurns?: number;
    maxConversationBytes?: number;
  };
  conversation_fold_failed: { reason?: string; failedAttemptCount?: number };
  conversation_folded: {
    beforeConversationBytes?: number;
    afterConversationBytes?: number;
    foldedTurnCount?: number;
    narrativeClipped?: boolean;
    degraded?: boolean;
    reason?: string;
    failedAttemptCount?: number;
    text?: string;
  };
  conversation_fold_narrative_clipped: { maxConversationBytes?: number };
  model_turn_retry: ModelTurnFailurePayload & { attempt?: number; maxRetries?: number; delayMs?: number };
  model_turn_error: ModelTurnFailurePayload;
  model_turn: {
    turnIndex?: number;
    model?: string;
    contentPreview?: string;
    toolCalls?: { id: string; name: string }[];
    usage?: ModelUsage;
    finishReason?: string;
    finalOnly?: boolean;
  };
  budget_update: { usage?: BudgetUsage; limits?: BudgetLimits };
  budget_blocked_tool_calls: {
    reason?: string;
    skippedCount?: number;
    toolNames?: string[];
  };
  tool_call: { id?: string; name?: string; input?: unknown };
  permission_decision: {
    toolCallId?: string;
    toolName?: string;
    capability?: Capability;
    decision?: string;
    riskTier?: RiskTier;
    reason?: string;
  };
  approval_decision: {
    toolCallId?: string;
    toolName?: string;
    status?: "approved" | "rejected" | "unavailable";
    reason?: string;
    fullPatchShown?: boolean;
  };
  tool_result: TraceToolObservationPayload;
  writing_artifact: TraceWritingArtifact;
  writing_project_updated: {
    slug?: string;
    memberAdded?: string;
    headBefore?: string | null;
    headAfter?: string | null;
  };
}

interface ConversationCompactionPayload extends Record<string, unknown> {
  compactedCount?: number;
  uncompactableCount?: number;
  beforeConversationBytes?: number;
  afterConversationBytes?: number;
  targetConversationBytes?: number;
  toolNames?: string[];
  residualOverageBytes?: number;
}

interface TraceWritingArtifact extends Record<string, unknown> {
  path: string;
  contentKind: "draft" | "revision" | "final";
  contentBytes: number;
}

interface ModelTurnFailurePayload extends Record<string, unknown> {
  turnIndex?: number;
  model?: string;
  finalOnly?: boolean;
  error?: unknown;
}

export const TRACED_OBSERVATION_KEYS = [
  "path",
  "truncated",
  "totalBytes",
  "returnedBytes",
  "contentHash",
  "rangeKind",
  "offsetBytes",
  "limitBytes",
  "startLine",
  "lineCount",
  "tailLines",
  "returnedStartByte",
  "returnedEndByte",
  "returnedStartLine",
  "returnedEndLine",
  "nextOffsetBytes",
  "preview",
  "changedFiles",
  "command",
  "exitCode",
  "durationMs",
  "timedOut",
  "scopeConstrained",
] as const satisfies readonly (keyof ObservationMetadata)[];

type TraceToolObservationPayload = Pick<
  ToolObservation,
  "ok" | "toolCallId" | "toolName" | "summary" | "error"
> & TracedObservationMetadata;

type TracedObservationMetadata = {
  -readonly [Key in (typeof TRACED_OBSERVATION_KEYS)[number]]?: ObservationMetadata[Key];
};

export function projectToolObservationForTrace(
  observation: ToolObservation,
): TraceToolObservationPayload {
  // Trace payloads intentionally omit content and web metadata; content belongs
  // only in the active model observation, while web provenance is recorded as
  // a context attachment under the Trace vocabulary.
  const metadata: TracedObservationMetadata = {};
  for (const key of TRACED_OBSERVATION_KEYS)
    (metadata as Record<string, unknown>)[key] = observation.metadata[key];
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    error: observation.error,
    ...metadata,
  };
}

export type TraceEventType = keyof TraceEventPayloads;

export type KnownTraceEvent = {
  [Type in TraceEventType]: {
    type: Type;
    ts: string;
    sessionId: string;
    payload: TraceEventPayloads[Type] & Record<string, unknown>;
  };
}[TraceEventType];

/** A malformed or forward-versioned line, retained but never treated as evidence. */
export interface UnknownTraceEvent {
  /** The observed type when available; invalid JSON uses a stable sentinel. */
  type: string;
  ts: "";
  sessionId: "";
  payload: Record<string, never>;
  unknown: true;
  rawLine: string;
  raw: unknown;
  reason: "invalid_json" | "invalid_envelope" | "unknown_type";
}

export type TraceEvent = KnownTraceEvent | UnknownTraceEvent;
export type TraceFileEvent = TraceEvent;

const traceEventTypes = [
  "session_started",
  "user_task",
  "session_continuation_started",
  "continuation_context_loaded",
  "context_attachment",
  "memory_loaded",
  "routing_selected",
  "workspace_baseline",
  "plan_update",
  "debug_transcript_started",
  "debug_transcript_finished",
  "final_summary",
  "session_finished",
  "session_resumed",
  "envelope_amended",
  "session_paused",
  "budget_wrapup_triggered",
  "conversation_compacted",
  "conversation_compaction_attempted",
  "conversation_fold_stopped",
  "conversation_fold_failed",
  "conversation_folded",
  "conversation_fold_narrative_clipped",
  "model_turn_retry",
  "model_turn_error",
  "model_turn",
  "budget_update",
  "budget_blocked_tool_calls",
  "tool_call",
  "permission_decision",
  "approval_decision",
  "tool_result",
  "writing_artifact",
  "writing_project_updated",
] as const satisfies readonly TraceEventType[];

type MissingTraceEventTypes = Exclude<TraceEventType, (typeof traceEventTypes)[number]>;
const allTraceEventTypesPresent: MissingTraceEventTypes extends never ? true : never = true;

const traceEventTypeSet = new Set<string>(traceEventTypes);

export function isTraceEvent(event: TraceFileEvent): event is KnownTraceEvent {
  return !("unknown" in event);
}

export function parseTraceEventLine(line: string): TraceFileEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    return unknownTraceEvent(line, undefined, "invalid_json");
  }
  if (!isRecord(raw) || !isTraceEnvelope(raw))
    return unknownTraceEvent(line, raw, "invalid_envelope");
  if (!traceEventTypeSet.has(raw.type))
    return unknownTraceEvent(line, raw, "unknown_type");
  return raw as unknown as KnownTraceEvent;
}

function isTraceEnvelope(value: Record<string, unknown>): value is {
  type: string;
  ts: string;
  sessionId: string;
  payload: Record<string, unknown>;
} {
  return (
    typeof value.type === "string" &&
    typeof value.ts === "string" &&
    typeof value.sessionId === "string" &&
    isRecord(value.payload)
  );
}

function unknownTraceEvent(
  rawLine: string,
  raw: unknown,
  reason: UnknownTraceEvent["reason"],
): UnknownTraceEvent {
  const type = isRecord(raw) && typeof raw.type === "string"
    ? raw.type
    : "unknown_trace_event";
  return { type, ts: "", sessionId: "", payload: {}, unknown: true, rawLine, raw, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
