import type { ModelClient, ModelMessage } from "../types.js";
import type { DebugTranscriptWriter } from "../debugTranscript/index.js";
import type { TraceEventPayloads, TraceEventType } from "../trace/index.js";
import { compactConversation } from "./compaction.js";
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
    state: ActiveContextCompactorState,
    turnIndex: number,
  ): Promise<ActiveContextFitResult>;
}

export interface ActiveContextSettings {
  maxConversationBytes: number;
  observationDigestPreviewBytes: number;
  protectedRecentTurns: number;
}

export type ActiveContextFitResult = {
  conversation: ModelMessage[];
  state: ActiveContextCompactorState;
} & (
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
  | { outcome: "exhausted" }
);

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
}

/** The sole external seam for Active Context compaction. It owns compaction,
 * fold attempt, compaction evidence, and fold debug transcript for one ReAct
 * Node turn; the kernel retains Session Budget enforcement. */
export function createActiveContextCompactor(
  input: CreateActiveContextCompactorInput,
): ActiveContextCompactor {
  return {
    async fitTurn(conversation, state, turnIndex) {
      const { conversation: compactedConversation, ...compaction } =
        compactConversation(conversation, {
          maxConversationBytes: input.settings.maxConversationBytes,
          observationDigestPreviewBytes:
            input.settings.observationDigestPreviewBytes,
          rollingSummaryText: state.rollingSummary?.text,
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
        conversation: compactedConversation,
        rollingSummary: state.rollingSummary,
        maxConversationBytes: input.settings.maxConversationBytes,
        protectedRecentTurns: input.settings.protectedRecentTurns,
        task: input.task,
        modelClient: input.modelClient,
        failedFoldAttempts: state.failedFoldAttempts,
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
        return {
          outcome: "exhausted",
          conversation: compactedConversation,
          state,
        };
      }
      const nextState: ActiveContextCompactorState =
        foldResult.outcome === "folded"
          ? { rollingSummary: foldResult.rollingSummary, failedFoldAttempts: 0 }
          : foldResult.outcome === "failed"
            ? { ...state, failedFoldAttempts: state.failedFoldAttempts + 1 }
            : state;
      if (foldResult.outcome === "failed") {
        await input.appendTrace("conversation_fold_failed", {
          reason: foldResult.reason,
          failedAttemptCount: nextState.failedFoldAttempts,
        });
      }
      if (foldResult.outcome === "folded") {
        await input.appendTrace("conversation_folded", { ...foldResult.trace });
        if (foldResult.trace.narrativeClipped)
          await input.appendTrace("conversation_fold_narrative_clipped", {
            maxConversationBytes: input.settings.maxConversationBytes,
          });
      }

      return {
        outcome: "fitted",
        conversation:
          foldResult.outcome === "folded"
            ? foldResult.keptTurns
            : compactedConversation,
        state: nextState,
        ...(foldResult.outcome === "folded"
          ? { foldUsage: foldResult.usage }
          : {}),
        ...(nextState.rollingSummary
          ? {
              rollingSummaryMessage: rollingSummaryMessage(
                nextState.rollingSummary,
              ),
            }
          : {}),
        ...(compaction.compactedCount > 0
          ? {
              compactionStatusLine: `Active observations compacted: ${compaction.afterConversationBytes}/${compaction.targetConversationBytes} bytes.`,
            }
          : {}),
      };
    },
  };
}
