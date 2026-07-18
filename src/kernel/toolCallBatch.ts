import type {
  AgentSession,
  Capability,
  ModelToolCall,
  ToolObservation,
  ToolRequest,
} from "../types.js";
import type {
  DebugTranscriptEvent,
  DebugTranscriptWriter,
} from "../debugTranscript/index.js";
import { SessionPauseSignal } from "../permissions/envelope.js";
import type { SessionLiveEvent, SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { TraceEventPayloads, TraceEventType } from "../trace/index.js";
import type { ToolRegistry } from "../tools/toolRegistry.js";

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

type ToolCallBatchOutcome =
  | { outcome: "completed"; observations: ToolObservation[] }
  | {
      outcome: "paused";
      pendingToolCall: ModelToolCall;
      pendingToolRequest: ToolRequest;
      remainingToolCalls: ModelToolCall[];
      executedObservations: ToolObservation[];
    };

interface RunAuditState {
  changedFiles: Set<string>;
  commands: { command: string; exitCode: number | null; timedOut: boolean }[];
}

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
  appendTrace<Type extends TraceEventType>(
    type: Type,
    payload: TraceEventPayloads[Type],
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
  appendTrace<Type extends TraceEventType>(
    type: Type,
    payload: TraceEventPayloads[Type],
    ts?: string,
  ): Promise<void>;
}): Promise<ToolObservation[]> => {
  const perCallTraceEvents: { append(): Promise<void> }[][] = input.toolCalls.map(
    () => [],
  );
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
          const ts = new Date().toISOString();
          perCallTraceEvents[index]?.push({
            append: () => input.appendTrace(type, payload, ts),
          });
        },
      }),
  );

  for (const events of perCallTraceEvents)
    for (const event of events)
      await event.append();
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
  appendTrace<Type extends TraceEventType>(
    type: Type,
    payload: TraceEventPayloads[Type],
  ): Promise<void>;
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
  await input.appendTrace("tool_result", traceToolObservation(execution.observation));
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

const traceToolObservation = (
  observation: ToolObservation,
): TraceEventPayloads["tool_result"] => {
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

const emitLiveEvent = async (
  sink: SessionLiveEventSink | undefined,
  event: SessionLiveEvent,
): Promise<void> => {
  if (sink) await sink(event);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
