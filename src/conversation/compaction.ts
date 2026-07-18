import type { ModelMessage } from "../types.js";
import {
  parseObservation,
  toObservationDigest,
  type ParsedObservation,
} from "../observation/index.js";
import { conversationBudgetBytes } from "./budget.js";

export interface CompactionOptions {
  maxConversationBytes: number;
  observationDigestPreviewBytes?: number;
  rollingSummaryText?: string;
}

export interface CompactionResult {
  compactedCount: number;
  uncompactableCount: number;
  beforeConversationBytes: number;
  afterConversationBytes: number;
  targetConversationBytes: number;
  toolNames: string[];
  residualOverageBytes: number;
}

export type CompactConversationResult = CompactionResult & {
  conversation: ModelMessage[];
};

const PRIORITY_TOOL_NAMES = new Set(["read_file", "git_diff", "run_command"]);

export function compactConversation(
  conversation: ModelMessage[],
  options: CompactionOptions,
): CompactConversationResult {
  const compactedConversation = [...conversation];
  const beforeConversationBytes = conversationBudgetBytes(
    compactedConversation,
    options.rollingSummaryText,
  );
  const result: CompactionResult = {
    compactedCount: 0,
    uncompactableCount: 0,
    beforeConversationBytes,
    afterConversationBytes: beforeConversationBytes,
    targetConversationBytes: options.maxConversationBytes,
    toolNames: [],
    residualOverageBytes: Math.max(
      0,
      beforeConversationBytes - options.maxConversationBytes,
    ),
  };
  if (beforeConversationBytes <= options.maxConversationBytes)
    return { ...result, conversation: compactedConversation };

  const toolMessages = compactedConversation
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool");
  const newestTurnStart = newestToolTurnStart(compactedConversation);
  const oldCandidates = toolMessages.filter(
    ({ index }) => index < newestTurnStart,
  );
  const candidates = [
    ...oldCandidates.filter(({ message }) => hasPriorityToolName(message)),
    ...oldCandidates.filter(({ message }) => !hasPriorityToolName(message)),
  ];
  const compactedTools = new Set<string>();

  for (const candidate of candidates) {
    if (
      conversationBudgetBytes(
        compactedConversation,
        options.rollingSummaryText,
      ) <= options.maxConversationBytes
    )
      break;
    const parsed = parseObservation(candidate.message.content);
    if (!parsed) {
      result.uncompactableCount += 1;
      continue;
    }
    if (parsed.compacted === true) continue;
    compactedConversation[candidate.index] = {
      ...candidate.message,
      content: JSON.stringify(compactObservation(parsed, options)),
    };
    result.compactedCount += 1;
    compactedTools.add(parsed.toolName);
  }

  result.afterConversationBytes = conversationBudgetBytes(
    compactedConversation,
    options.rollingSummaryText,
  );
  result.toolNames = [...compactedTools];
  result.residualOverageBytes = Math.max(
    0,
    result.afterConversationBytes - options.maxConversationBytes,
  );
  return { ...result, conversation: compactedConversation };
}

function newestToolTurnStart(conversation: ModelMessage[]): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
      return index;
  }
  return conversation.length;
}

function hasPriorityToolName(message: ModelMessage): boolean {
  const parsed = parseObservation(message.content);
  return parsed ? PRIORITY_TOOL_NAMES.has(parsed.toolName) : false;
}

function compactObservation(
  observation: ParsedObservation,
  options: CompactionOptions,
): ParsedObservation {
  const digest = toObservationDigest(
    observation,
    options.observationDigestPreviewBytes ?? 2_048,
  );
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    digest: digest.digest,
    compacted: true,
    error: compactError(observation.error),
    metadata: digest.metadata,
  };
}

function compactError(
  error: ParsedObservation["error"],
): ParsedObservation["error"] {
  if (!error) return undefined;
  return {
    code: error.code,
    message: error.message,
  };
}
