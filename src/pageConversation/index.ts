/**
 * Dependency-free Page Conversation vocabulary. These types are consumed by
 * the browser extension only through type-only imports, which compile away
 * before buildExtension copies its fixed bundle files (ADR 0062).
 */

export interface PageConversationTurn {
  sessionId: string;
  question: string;
  answer: string;
}

export type PageAnswerGroundingStatus = "supported" | "not_found";

export interface PageAnswer {
  answer: string;
  groundingStatus: PageAnswerGroundingStatus;
  evidence: string[];
}

export interface PageBrief {
  summary: string;
  keyConcepts: string;
}

export type PageConversationAttemptKind =
  | "root"
  | "root_retry"
  | "follow_up"
  | "follow_up_retry";
