import type { ModelClient, ModelMessage } from "../types.js";
import type { DebugTranscriptWriter } from "../debugTranscript/index.js";
import type { TraceEventPayloads, TraceEventType } from "../trace/index.js";
import { compactConversationInPlace } from "./compaction.js";
import {
  attemptConversationFold,
  rollingSummaryMessage,
  type RollingSummaryState,
} from "./fold.js";

export type { RollingSummaryState } from "./fold.js";

export interface ActiveContextCompactorState {
  rollingSummary?: RollingSummaryState;
  failedFoldAttempts: number;
}

export interface ActiveContextCompactor {
  fitTurn(
    conversation: ModelMessage[],
    turnIndex: number,
  ): Promise<ActiveContextFitResult>;
  state(): ActiveContextCompactorState;
}

export interface ActiveContextSettings {
  maxConversationBytes: number;
  observationDigestPreviewBytes: number;
  protectedRecentTurns: number;
}

export type ActiveContextFitResult =
  | {
      outcome: "fitted";
      foldUsage?: {
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
        unpricedTurns: number;
      };
      rollingSummaryMessage?: ModelMessage;
      compactionStatusLine?: string;
    }
  | { outcome: "exhausted" };

export interface CreateActiveContextCompactorInput {
  modelClient: ModelClient;
  task: string;
  sessionId: string;
  model: string;
  appendTrace<Type extends TraceEventType>(
    type: Type,
    payload: TraceEventPayloads[Type],
  ): Promise<void>;
  debugTranscript?: DebugTranscriptWriter;
  settings: ActiveContextSettings;
  restoreState?: Partial<ActiveContextCompactorState>;
}

/** The sole external seam for Active Context compaction. It owns the mutation,
 * fold attempt, compaction evidence, and fold debug transcript for one ReAct
 * Node run; the kernel retains Session Budget enforcement. */
export function createActiveContextCompactor(
  input: CreateActiveContextCompactorInput,
): ActiveContextCompactor {
  let rollingSummary = input.restoreState?.rollingSummary;
  let failedFoldAttempts = input.restoreState?.failedFoldAttempts ?? 0;

  return {
    async fitTurn(conversation, turnIndex) {
      const compaction = compactConversationInPlace(conversation, {
        maxConversationBytes: input.settings.maxConversationBytes,
        observationDigestPreviewBytes:
          input.settings.observationDigestPreviewBytes,
        rollingSummaryText: rollingSummary?.text,
      });
      if (
        compaction.compactedCount > 0 ||
        compaction.beforeConversationBytes > compaction.targetConversationBytes
      )
        await input.appendTrace(
          compaction.compactedCount > 0
            ? "conversation_compacted"
            : "conversation_compaction_attempted",
          { ...compaction },
        );

      const foldResult = await attemptConversationFold({
        conversation,
        rollingSummary,
        maxConversationBytes: input.settings.maxConversationBytes,
        protectedRecentTurns: input.settings.protectedRecentTurns,
        task: input.task,
        modelClient: input.modelClient,
        failedFoldAttempts,
        onModelRequest: (messages) =>
          input.debugTranscript?.append({
            type: "model_request",
            ts: new Date().toISOString(),
            sessionId: input.sessionId,
            payload: {
              turnIndex,
              model: input.model,
              purpose: "conversation_fold",
              messages,
              tools: [],
            },
          }),
        onModelResponse: (content) =>
          input.debugTranscript?.append({
            type: "model_response",
            ts: new Date().toISOString(),
            sessionId: input.sessionId,
            payload: {
              turnIndex,
              model: input.model,
              purpose: "conversation_fold",
              content,
            },
          }),
      });
      if (foldResult.outcome === "stop") {
        await input.appendTrace("conversation_fold_stopped", {
          protectedRecentTurns: input.settings.protectedRecentTurns,
          maxConversationBytes: input.settings.maxConversationBytes,
        });
        return { outcome: "exhausted" };
      }
      if (foldResult.outcome === "failed") {
        failedFoldAttempts += 1;
        await input.appendTrace("conversation_fold_failed", {
          reason: foldResult.reason,
          failedAttemptCount: failedFoldAttempts,
        });
      }
      if (foldResult.outcome === "folded") {
        failedFoldAttempts = 0;
        rollingSummary = foldResult.rollingSummary;
        await input.appendTrace("conversation_folded", { ...foldResult.trace });
        if (foldResult.trace.narrativeClipped)
          await input.appendTrace("conversation_fold_narrative_clipped", {
            maxConversationBytes: input.settings.maxConversationBytes,
          });
      }

      return {
        outcome: "fitted",
        ...(foldResult.outcome === "folded"
          ? { foldUsage: foldResult.usage }
          : {}),
        ...(rollingSummary
          ? { rollingSummaryMessage: rollingSummaryMessage(rollingSummary) }
          : {}),
        ...(compaction.compactedCount > 0
          ? {
              compactionStatusLine: `Active observations compacted: ${compaction.afterConversationBytes}/${compaction.targetConversationBytes} bytes.`,
            }
          : {}),
      };
    },
    state: () => ({
      ...(rollingSummary ? { rollingSummary } : {}),
      failedFoldAttempts,
    }),
  };
}
