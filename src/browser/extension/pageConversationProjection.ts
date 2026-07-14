// Type-only: erased at compile time, so the copied extension bundle stays
// dependency-free (buildExtension copies compiled files as-is).
import type { PageAnswer, PageBrief } from "../../workflows/learning.js";

export type { PageAnswer, PageBrief };

/** Schema-versioned per ADR 0054: unversioned or older projection state is
 * discarded rather than migrated (WP11), never silently reinterpreted. */
export const PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION = 3;

export type PageConversationAttemptKind =
  | "root"
  | "root_retry"
  | "follow_up"
  | "follow_up_retry";

export interface PageConversationSourceHeader {
  url: string;
  title: string;
  capturedAt: string;
  truncated: boolean;
}

/** A normalized, successfully completed turn. Root delivers a Page Brief and
 * carries no question; every follow-up delivers a Page Answer, including a
 * not-found grounding status, which is a successful turn like any other. */
export interface PageConversationSuccessfulTurn {
  invocationId: string;
  sessionId: string;
  kind: "root" | "follow_up";
  question?: string;
  pageBrief?: PageBrief;
  pageAnswer?: PageAnswer;
}

export interface PageConversationTerminalCard {
  invocationId: string;
  kind: PageConversationAttemptKind;
  status: "stopped" | "failed" | "rejected";
  reason: string;
  question?: string;
  sessionId?: string;
}

export type PageConversationAttemptStatus = "starting" | "running" | "stopping";

/** Live presentation of the in-flight attempt only; it is never durable and
 * is replaced wholesale once a terminal frame arrives. */
export interface PageConversationCurrentAttempt {
  invocationId: string;
  actionId: string;
  kind: PageConversationAttemptKind;
  status: PageConversationAttemptStatus;
  question?: string;
  sessionId?: string;
  tracePath?: string;
  liveText?: string;
  turnIndex?: number;
  model?: string;
  activity?: string;
}

export interface PageConversationProjection {
  schemaVersion: typeof PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION;
  conversationId: string;
  captureId: string;
  workspaceProfileId: string;
  source: PageConversationSourceHeader;
  rootSessionId?: string;
  headSessionId?: string;
  turns: PageConversationSuccessfulTurn[];
  terminalCards: PageConversationTerminalCard[];
  currentAttempt?: PageConversationCurrentAttempt;
  historyEvicted: boolean;
}

/** Starts a brand-new Page Conversation with its root attempt in flight. A
 * root always begins a fresh projection: it is never applied on top of an
 * existing one. */
export function createPageConversationProjection(input: {
  conversationId: string;
  actionId: string;
  invocationId: string;
  workspaceProfileId: string;
  captureId: string;
  source: PageConversationSourceHeader;
}): PageConversationProjection {
  return {
    schemaVersion: PAGE_CONVERSATION_PROJECTION_SCHEMA_VERSION,
    conversationId: input.conversationId,
    captureId: input.captureId,
    workspaceProfileId: input.workspaceProfileId,
    source: input.source,
    turns: [],
    terminalCards: [],
    currentAttempt: {
      invocationId: input.invocationId,
      actionId: input.actionId,
      kind: "root",
      status: "starting",
    },
    historyEvicted: false,
  };
}

/** Starts a non-root attempt (root Retry, follow-up, or follow-up Retry) on
 * top of an existing projection. Only one attempt may be in flight per
 * conversation (ADR 0050): callers must not invoke this while
 * `currentAttempt` is already set. */
export function startPageConversationAttempt(
  projection: PageConversationProjection,
  input: {
    kind: Exclude<PageConversationAttemptKind, "root">;
    actionId: string;
    invocationId: string;
    question?: string;
  },
): PageConversationProjection {
  return {
    ...projection,
    currentAttempt: {
      invocationId: input.invocationId,
      actionId: input.actionId,
      kind: input.kind,
      status: "starting",
      ...(input.question !== undefined ? { question: input.question } : {}),
    },
  };
}

/** Marks the named in-flight attempt as stopping. A no-op for any other
 * invocation identity: Stop targets only the active attempt. */
export function markPageConversationAttemptStopping(
  projection: PageConversationProjection,
  invocationId: string,
): PageConversationProjection {
  const current = projection.currentAttempt;
  if (!current || current.invocationId !== invocationId) return projection;
  return { ...projection, currentAttempt: { ...current, status: "stopping" } };
}

/** Applies one Browser Run Frame (src/browser/protocol.ts) to a projection.
 * Frames whose invocationId no longer matches the current attempt are
 * ignored: they are late/stale frames from an attempt that already reached
 * a terminal state (e.g. a Retry started before an old frame arrived). */
export function applyPageConversationFrame(
  projection: PageConversationProjection,
  frame: Record<string, unknown>,
): PageConversationProjection {
  const current = projection.currentAttempt;
  if (!current || frame.invocationId !== current.invocationId) return projection;

  if (frame.type === "session_ready") {
    return {
      ...projection,
      currentAttempt: {
        ...current,
        status: "running",
        sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
        tracePath: typeof frame.tracePath === "string" ? frame.tracePath : undefined,
      },
    };
  }

  if (frame.type === "live_event") {
    return { ...projection, currentAttempt: applyLiveEvent(current, frame.event) };
  }

  if (frame.type === "page_brief_completed") {
    const sessionId = current.sessionId ?? "";
    const turn: PageConversationSuccessfulTurn = {
      invocationId: current.invocationId,
      sessionId,
      kind: "root",
      pageBrief: frame.pageBrief as PageBrief,
    };
    return {
      ...projection,
      rootSessionId: sessionId,
      headSessionId: sessionId,
      turns: [...projection.turns, turn],
      currentAttempt: undefined,
    };
  }

  if (frame.type === "page_answer_completed") {
    const sessionId = current.sessionId ?? "";
    const turn: PageConversationSuccessfulTurn = {
      invocationId: current.invocationId,
      sessionId,
      kind: "follow_up",
      ...(current.question !== undefined ? { question: current.question } : {}),
      pageAnswer: frame.pageAnswer as PageAnswer,
    };
    return {
      ...projection,
      headSessionId: sessionId,
      turns: [...projection.turns, turn],
      currentAttempt: undefined,
    };
  }

  if (frame.type === "stopped") {
    return {
      ...projection,
      terminalCards: [
        ...projection.terminalCards,
        terminalCardFrom(current, "stopped", String(frame.reason ?? "user_stopped")),
      ],
      currentAttempt: undefined,
    };
  }

  if (frame.type === "failed") {
    return {
      ...projection,
      terminalCards: [
        ...projection.terminalCards,
        terminalCardFrom(current, "failed", String(frame.message ?? "Browser Workbench failed.")),
      ],
      currentAttempt: undefined,
    };
  }

  if (frame.type === "launch_rejected") {
    return {
      ...projection,
      terminalCards: [
        ...projection.terminalCards,
        terminalCardFrom(current, "rejected", String(frame.reason ?? "Browser Workbench rejected the attempt.")),
      ],
      currentAttempt: undefined,
    };
  }

  if (frame.type === "action_conflict") {
    return {
      ...projection,
      terminalCards: [
        ...projection.terminalCards,
        terminalCardFrom(current, "failed", "This attempt was already submitted with different details."),
      ],
      currentAttempt: undefined,
    };
  }

  return projection;
}

function terminalCardFrom(
  current: PageConversationCurrentAttempt,
  status: PageConversationTerminalCard["status"],
  reason: string,
): PageConversationTerminalCard {
  return {
    invocationId: current.invocationId,
    kind: current.kind,
    status,
    reason,
    ...(current.question !== undefined ? { question: current.question } : {}),
    ...(current.sessionId !== undefined ? { sessionId: current.sessionId } : {}),
  };
}

function applyLiveEvent(
  current: PageConversationCurrentAttempt,
  event: unknown,
): PageConversationCurrentAttempt {
  if (!isRecord(event)) return current;
  if (event.type === "model_turn_started") {
    return {
      ...current,
      turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : current.turnIndex,
      model: typeof event.model === "string" ? event.model : current.model,
      liveText: "",
      activity: undefined,
    };
  }
  if (event.type === "model_output_delta") {
    return {
      ...current,
      turnIndex: typeof event.turnIndex === "number" ? event.turnIndex : current.turnIndex,
      model: typeof event.model === "string" ? event.model : current.model,
      liveText: (current.liveText ?? "") + (typeof event.text === "string" ? event.text : ""),
    };
  }
  if (event.type === "tool_call_started") {
    const target = typeof event.target === "string" ? ` ${event.target}` : "";
    return { ...current, activity: `Tool started: ${String(event.toolName ?? "")}${target}` };
  }
  if (event.type === "tool_call_finished") {
    return {
      ...current,
      activity: `Tool finished: ${String(event.toolName ?? "")} (${event.ok ? "ok" : "failed"})`,
    };
  }
  return current;
}

export function modelOutputDeltaText(frame: Record<string, unknown>): string | undefined {
  if (frame.type !== "live_event" || !isRecord(frame.event)) return undefined;
  if (frame.event.type !== "model_output_delta") return undefined;
  return typeof frame.event.text === "string" ? frame.event.text : "";
}

/** The deterministic byte budget ADR 0052 requires: implementation-tuned,
 * locked by a focused test rather than derived from the design doc. */
export const DEFAULT_PROJECTION_BYTE_BUDGET = 24 * 1024;

/** Evicts the oldest terminal cards, then the oldest successful turns
 * (excluding the root Page Brief and the current head), until the
 * projection fits its byte budget. Source header, Page Brief, head, and the
 * current attempt are always preserved. */
export function evictPageConversationProjection(
  projection: PageConversationProjection,
  maxBytes: number = DEFAULT_PROJECTION_BYTE_BUDGET,
): PageConversationProjection {
  let next = projection;
  let evicted = false;

  while (projectionByteSize(next) > maxBytes && next.terminalCards.length > 0) {
    next = { ...next, terminalCards: next.terminalCards.slice(1) };
    evicted = true;
  }

  while (projectionByteSize(next) > maxBytes && next.turns.length > 2) {
    const [root, ...rest] = next.turns;
    const head = rest.at(-1)!;
    const middle = rest.slice(0, -1);
    next = { ...next, turns: [root, ...middle.slice(1), head] };
    evicted = true;
  }

  return evicted ? { ...next, historyEvicted: true } : next;
}

function projectionByteSize(projection: PageConversationProjection): number {
  return utf8ByteLength(JSON.stringify(projection));
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
