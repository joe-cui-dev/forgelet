import { findSessionTracePath, isTraceEvent, readTraceFile, type TraceEvent } from "../trace/index.js";

/** Matches `BrowserInvocationRequest["kind"]` (src/browser/protocol.ts); kept
 * as a separate literal union here so this read model does not import the
 * protocol layer for a browser-policy-free Trace concern. */
export type PageConversationAttemptKind =
  | "root"
  | "root_retry"
  | "follow_up"
  | "follow_up_retry";

/** The `session_started.payload.trigger` shape a Page Conversation Session
 * launcher (WP8) is expected to record, per ADR 0051. */
export interface PageConversationTrigger {
  kind: PageConversationAttemptKind;
  conversationId: string;
  captureId: string;
  invocationId?: string;
  workspaceProfileId?: string;
  parentSessionId?: string;
  outputLanguage?: string;
}

export interface PageConversationTurn {
  sessionId: string;
  question: string;
  answer: string;
}

export interface PageConversationHistory {
  conversationId: string;
  captureId: string;
  rootSessionId: string;
  headSessionId: string;
  turns: PageConversationTurn[];
}

export type PageConversationHistoryUnavailableReason =
  "conversation_history_unavailable";

/** Thrown instead of returning a degraded/partial history: ADR 0047 requires
 * a follow-up launch to fail before Session creation rather than fall back to
 * generic degraded continuation or the disposable browser projection. */
export class PageConversationHistoryUnavailableError extends Error {
  readonly reason: PageConversationHistoryUnavailableReason =
    "conversation_history_unavailable";
  constructor(message: string) {
    super(message);
    this.name = "PageConversationHistoryUnavailableError";
  }
}

const MAX_PAGE_CONVERSATION_CHAIN_LENGTH = 500;

/**
 * Reconstructs the ordered, linear Page Conversation History a follow-up
 * Session inherits (ADR 0045, ADR 0046): the root Page Brief plus every
 * successfully completed child Page Answer, walked backward from the
 * declared current head to the declared root using only each ancestor
 * Session's own recorded Trace metadata. Never trusts the disposable browser
 * projection, and never infers identity from a Trace file name.
 */
export async function readPageConversationHistory(input: {
  workspaceRoot: string;
  conversationId: string;
  captureId: string;
  rootSessionId: string;
  headSessionId: string;
}): Promise<PageConversationHistory> {
  const { workspaceRoot, conversationId, captureId, rootSessionId, headSessionId } =
    input;

  const chain: { sessionId: string; events: TraceEvent[] }[] = [];
  const seen = new Set<string>();
  let currentSessionId = headSessionId;

  while (true) {
    if (seen.has(currentSessionId))
      throw unavailable(
        `Page Conversation ancestor chain is not linear (repeated Session ${currentSessionId}).`,
      );
    seen.add(currentSessionId);
    if (chain.length >= MAX_PAGE_CONVERSATION_CHAIN_LENGTH)
      throw unavailable(
        "Page Conversation ancestor chain exceeds the supported length.",
      );

    const events = await readAncestorTrace(workspaceRoot, currentSessionId);
    const started = events.find((event) => event.type === "session_started");
    if (!started)
      throw unavailable(
        `Ancestor Session trace is malformed: ${currentSessionId}.`,
      );
    if (started.payload.workflow !== "learning")
      throw unavailable(
        `Ancestor Session is not a Learning Workflow Session: ${currentSessionId}.`,
      );

    const trigger = asPageConversationTrigger(started.payload.trigger);
    if (!trigger)
      throw unavailable(
        `Ancestor Session is missing Page Conversation trigger metadata: ${currentSessionId}.`,
      );
    if (trigger.conversationId !== conversationId)
      throw unavailable(
        `Ancestor Session belongs to a different Page Conversation: ${currentSessionId}.`,
      );
    if (trigger.captureId !== captureId)
      throw unavailable(
        `Ancestor Session used a different capture: ${currentSessionId}.`,
      );

    const finished = events.find((event) => event.type === "session_finished");
    if (finished?.payload.status !== "completed")
      throw unavailable(
        `Ancestor Session did not complete successfully: ${currentSessionId}.`,
      );

    chain.push({ sessionId: currentSessionId, events });

    if (trigger.kind === "root" || trigger.kind === "root_retry") {
      if (currentSessionId !== rootSessionId)
        throw unavailable(
          `Page Conversation ancestor chain reached a root Session that does not match the declared root: ${currentSessionId}.`,
        );
      break;
    }

    if (!trigger.parentSessionId)
      throw unavailable(
        `Ancestor Session is missing a parent Session identity: ${currentSessionId}.`,
      );
    currentSessionId = trigger.parentSessionId;
  }

  const orderedChain = [...chain].reverse();
  const turns = orderedChain.map(({ sessionId, events }) =>
    turnFromAncestorEvents(sessionId, events),
  );

  return { conversationId, captureId, rootSessionId, headSessionId, turns };
}

function turnFromAncestorEvents(
  sessionId: string,
  events: TraceEvent[],
): PageConversationTurn {
  const task = events.find((event) => event.type === "user_task");
  const finalSummary = events.find((event) => event.type === "final_summary");
  const question = task?.payload.task;
  const answer = finalSummary?.payload.finalContent;
  if (typeof question !== "string" || typeof answer !== "string")
    throw unavailable(
      `Ancestor Session is missing its recorded task or normalized final answer: ${sessionId}.`,
    );
  return { sessionId, question, answer };
}

async function readAncestorTrace(
  workspaceRoot: string,
  sessionId: string,
): Promise<TraceEvent[]> {
  try {
    return (await readTraceFile(
      await findSessionTracePath(workspaceRoot, sessionId),
    )).filter(isTraceEvent);
  } catch {
    throw unavailable(
      `Ancestor Session trace is missing or unreadable: ${sessionId}.`,
    );
  }
}

function asPageConversationTrigger(
  value: unknown,
): PageConversationTrigger | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (
    kind !== "root" &&
    kind !== "root_retry" &&
    kind !== "follow_up" &&
    kind !== "follow_up_retry"
  )
    return undefined;
  const conversationId = record.conversationId;
  const captureId = record.captureId;
  if (typeof conversationId !== "string" || typeof captureId !== "string")
    return undefined;
  return {
    kind,
    conversationId,
    captureId,
    ...(typeof record.invocationId === "string"
      ? { invocationId: record.invocationId }
      : {}),
    ...(typeof record.workspaceProfileId === "string"
      ? { workspaceProfileId: record.workspaceProfileId }
      : {}),
    ...(typeof record.parentSessionId === "string"
      ? { parentSessionId: record.parentSessionId }
      : {}),
    ...(typeof record.outputLanguage === "string"
      ? { outputLanguage: record.outputLanguage }
      : {}),
  };
}

function unavailable(message: string): PageConversationHistoryUnavailableError {
  return new PageConversationHistoryUnavailableError(message);
}
