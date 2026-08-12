import {
  createConversationKnowledgeNote,
  type CreatedKnowledgeNote,
} from "../knowledge/index.js";
import {
  findSessionTracePath,
  isTraceEvent,
  listSessionTraceFiles,
  readTraceFile,
  type TraceEvent,
} from "../trace/index.js";
import type { ContextAttachment } from "../types.js";
import type { PageConversationTurn } from "../pageConversation/index.js";
import { readPageConversationHistory } from "./pageConversationHistory.js";

export type KnowledgeNotePromotionRejectionReason = "conversation_not_found";

/** Raised when a Page Conversation cannot be resolved into a promotable chain
 * (no root Trace, or a root Session that is not a Browser Workbench root). The
 * typed reason lets the CLI and Native Host present a stable recovery path
 * without parsing a free-text message, mirroring the follow-up preflight
 * rejection codes. History reconstruction failures keep surfacing as their own
 * PageConversationHistoryUnavailableError. */
export class KnowledgeNotePromotionError extends Error {
  readonly reason: KnowledgeNotePromotionRejectionReason;
  constructor(reason: KnowledgeNotePromotionRejectionReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "KnowledgeNotePromotionError";
  }
}

export interface PromotePageConversationInput {
  workspaceRoot: string;
  conversationId: string;
  rootSessionId: string;
  headSessionId: string;
  title: string;
  createdAt?: string;
}

/**
 * Promotes a whole Page Conversation — the root Page Brief plus every
 * successfully completed follow-up Page Answer — into a single Knowledge Note
 * (ADR 0077). This is a deterministic projection of Traces the conversation
 * already recorded: it never starts a model, and the Note file it writes is its
 * own evidence, so no new Trace vocabulary is involved. Depends on `knowledge`;
 * `knowledge` must never depend back on `browserWorkbench`.
 */
export async function promotePageConversationToKnowledgeNote(
  input: PromotePageConversationInput,
): Promise<CreatedKnowledgeNote> {
  const { captureId, sources } = await readRootCaptureAndSources(
    input.workspaceRoot,
    input.rootSessionId,
  );

  const history = await readPageConversationHistory({
    workspaceRoot: input.workspaceRoot,
    conversationId: input.conversationId,
    captureId,
    rootSessionId: input.rootSessionId,
    headSessionId: input.headSessionId,
  });

  return createConversationKnowledgeNote(input.workspaceRoot, {
    scope: "project",
    conversationId: input.conversationId,
    rootSessionId: input.rootSessionId,
    headSessionId: input.headSessionId,
    title: input.title,
    body: renderPageConversationBody(history.turns),
    sources,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

export interface ResolvedPageConversationEndpoints {
  rootSessionId: string;
  headSessionId: string;
  /** The captured page title, prefilled as the default Note title when the
   * caller (the CLI) supplies no `--title`. */
  pageTitle: string;
}

/** Resolves the root and current head of a Page Conversation by scanning the
 * workspace Traces for `session_started.payload.trigger.conversationId` (ADR
 * 0051). The CLI needs this because a human passes only a conversationId; the
 * Browser Workbench already knows its own root/head and passes them directly.
 * The head is the latest completed Session in the conversation; a later
 * successful retry therefore supersedes the failed attempt it replaced. */
export async function resolvePageConversationEndpoints(
  workspaceRoot: string,
  conversationId: string,
): Promise<ResolvedPageConversationEndpoints> {
  const sessions: {
    sessionId: string;
    kind: string;
    parentSessionId?: string;
    completed: boolean;
    ts: string;
    pageTitle?: string;
  }[] = [];
  for (const path of await listSessionTraceFiles(workspaceRoot)) {
    const events = (await readTraceFile(path)).filter(isTraceEvent);
    const started = events.find((event) => event.type === "session_started");
    if (!started) continue;
    const trigger = (started.payload as Record<string, unknown>).trigger;
    if (!isRecord(trigger) || trigger.conversationId !== conversationId) continue;
    const finished = events.find((event) => event.type === "session_finished");
    const status = (finished?.payload as Record<string, unknown> | undefined)?.status;
    const attachment = events.find((event) => event.type === "context_attachment");
    const pageTitle = isRecord(attachment?.payload)
      ? attachment.payload.title
      : undefined;
    sessions.push({
      sessionId: started.sessionId,
      kind: typeof trigger.kind === "string" ? trigger.kind : "",
      ...(typeof trigger.parentSessionId === "string"
        ? { parentSessionId: trigger.parentSessionId }
        : {}),
      completed: status === "completed",
      ts: started.ts,
      ...(typeof pageTitle === "string" ? { pageTitle } : {}),
    });
  }

  const completed = sessions.filter((session) => session.completed);
  const root = completed.find(
    (session) => session.kind === "root" || session.kind === "root_retry",
  );
  if (!root)
    throw new KnowledgeNotePromotionError(
      "conversation_not_found",
      `No completed Page Conversation found for conversation: ${conversationId}.`,
    );
  // The head is the tip of the chain: a completed Session that no other
  // completed Session claims as its parent. Ties (rare branches) resolve to the
  // latest start, so a fresh follow-up always wins over an abandoned sibling.
  const claimedAsParent = new Set(
    completed.flatMap((session) =>
      session.parentSessionId ? [session.parentSessionId] : [],
    ),
  );
  const tips = completed.filter((session) => !claimedAsParent.has(session.sessionId));
  const head = (tips.length > 0 ? tips : completed).reduce(
    (latest, session) => (session.ts >= latest.ts ? session : latest),
    root,
  );
  return {
    rootSessionId: root.sessionId,
    headSessionId: head.sessionId,
    pageTitle: root.pageTitle ?? "Page Conversation",
  };
}

/** Convenience path for callers that hold only a conversationId (the CLI):
 * resolve the endpoints, then promote. Defaults the Note title to the captured
 * page title when none is supplied (ADR 0077 decision 8). */
export async function promotePageConversationById(input: {
  workspaceRoot: string;
  conversationId: string;
  title?: string;
  createdAt?: string;
}): Promise<CreatedKnowledgeNote> {
  const endpoints = await resolvePageConversationEndpoints(
    input.workspaceRoot,
    input.conversationId,
  );
  return promotePageConversationToKnowledgeNote({
    workspaceRoot: input.workspaceRoot,
    conversationId: input.conversationId,
    rootSessionId: endpoints.rootSessionId,
    headSessionId: endpoints.headSessionId,
    title: input.title?.trim() || endpoints.pageTitle,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

/** Renders the ordered chain as one Markdown body: the root Page Brief's
 * Summary/Key Concepts verbatim, then a section per follow-up carrying the
 * question and the full Page Answer (Answer and Evidence are always kept, per
 * ADR 0077 decision 9). The Answer/Evidence headings are demoted one level so
 * they nest under their follow-up section. */
function renderPageConversationBody(turns: PageConversationTurn[]): string {
  const [root, ...followUps] = turns;
  const sections: string[] = [];
  if (root) sections.push(root.answer.trim());
  followUps.forEach((turn, index) => {
    sections.push(`## Follow-up ${index + 1}: ${flattenQuestion(turn.question)}`);
    sections.push(demoteHeadings(turn.answer.trim()));
  });
  return sections.join("\n\n");
}

function flattenQuestion(question: string): string {
  return question.replace(/\s+/g, " ").trim();
}

function demoteHeadings(markdown: string): string {
  return markdown.replace(/^(#{1,5}) /gm, "#$1 ");
}

async function readRootCaptureAndSources(
  workspaceRoot: string,
  rootSessionId: string,
): Promise<{ captureId: string; sources: ContextAttachment[] }> {
  let events: TraceEvent[];
  try {
    events = (
      await readTraceFile(await findSessionTracePath(workspaceRoot, rootSessionId))
    ).filter(isTraceEvent);
  } catch {
    throw new KnowledgeNotePromotionError(
      "conversation_not_found",
      `Page Conversation root Session trace is missing or unreadable: ${rootSessionId}.`,
    );
  }

  const started = events.find((event) => event.type === "session_started");
  const captureId = rootCaptureId(started);
  if (typeof captureId !== "string" || captureId.trim() === "")
    throw new KnowledgeNotePromotionError(
      "conversation_not_found",
      `Session is not a Page Conversation root: ${rootSessionId}.`,
    );

  // Pass the validated attachment through as-is, mirroring the Session-derived
  // note path in knowledge/index.ts; the Note renderer reads only the fields it
  // needs, so nothing is dropped by rebuilding the object.
  const sources = events
    .filter((event) => event.type === "context_attachment")
    .flatMap((event) =>
      isContextAttachment(event.payload) ? [event.payload] : [],
    );

  return { captureId, sources };
}

function rootCaptureId(started: TraceEvent | undefined): string | undefined {
  const trigger = (started?.payload as Record<string, unknown> | undefined)?.trigger;
  if (typeof trigger !== "object" || trigger === null) return undefined;
  const captureId = (trigger as Record<string, unknown>).captureId;
  return typeof captureId === "string" ? captureId : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContextAttachment(value: unknown): value is ContextAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ContextAttachment).id === "string" &&
    typeof (value as ContextAttachment).source === "string" &&
    typeof (value as ContextAttachment).mimeType === "string" &&
    typeof (value as ContextAttachment).contentBytes === "number" &&
    typeof (value as ContextAttachment).contentHash === "string" &&
    typeof (value as ContextAttachment).preview === "string" &&
    typeof (value as ContextAttachment).trustLevel === "string"
  );
}
