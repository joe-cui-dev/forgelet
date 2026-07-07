import type { ModelClient, ModelMessage } from "../types.js";
import {
  clipUtf8WithSuffix,
  conversationBudgetBytes,
  NARRATIVE_BUDGET_RATIO,
  rollingSummaryContent,
  rollingSummaryContentBytes,
  subBudgetBytes,
} from "./budget.js";
import {
  buildFactLedger,
  renderFactLedger,
  type FactLedger,
} from "./factLedger.js";
import { planFold } from "./foldPlanner.js";

export interface RollingSummaryState {
  text: string;
  ledger: FactLedger;
}

export interface FoldAttemptInput {
  conversation: ModelMessage[];
  rollingSummary: RollingSummaryState | undefined;
  maxConversationBytes: number;
  protectedRecentTurns: number;
  task: string;
  modelClient: ModelClient;
  failedFoldAttempts?: number;
  onModelRequest?: (messages: ModelMessage[]) => Promise<void> | void;
  onModelResponse?: (content: string | undefined) => Promise<void> | void;
}

export type FoldAttemptResult =
  | { outcome: "none" }
  | { outcome: "stop" }
  | {
      outcome: "folded";
      rollingSummary: RollingSummaryState;
      usage: {
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd: number;
      };
      trace: {
        beforeConversationBytes: number;
        afterConversationBytes: number;
        foldedTurnCount: number;
        narrativeClipped: boolean;
        degraded?: boolean;
        reason?: string;
        failedAttemptCount?: number;
        text: string;
      };
    }
  | {
      outcome: "failed";
      reason: string;
    };

export async function attemptConversationFold(
  input: FoldAttemptInput,
): Promise<FoldAttemptResult> {
  const rollingSummaryBytes = input.rollingSummary
    ? rollingSummaryContentBytes(input.rollingSummary.text)
    : 0;
  const plan = planFold(input.conversation, {
    maxConversationBytes: input.maxConversationBytes,
    protectedRecentTurns: input.protectedRecentTurns,
    rollingSummaryBytes,
  });
  if (plan.action === "none") return { outcome: "none" };
  if (plan.action === "stop") return { outcome: "stop" };

  const beforeConversationBytes =
    conversationBudgetBytes(input.conversation, input.rollingSummary?.text);
  const narrativeBudgetBytes = subBudgetBytes(
    input.maxConversationBytes,
    NARRATIVE_BUDGET_RATIO,
  );
  const summarizationMessages = buildSummarizationMessages(
    input.rollingSummary?.text,
    plan.foldTurns,
    narrativeBudgetBytes,
  );

  await input.onModelRequest?.(summarizationMessages);
  let content: string | undefined;
  let usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  } = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  try {
    const output = await input.modelClient.createTurn({
      task: input.task,
      messages: summarizationMessages,
      tools: [],
    });
    content = output.content;
    usage = {
      inputTokens: output.usage?.inputTokens ?? 0,
      outputTokens: output.usage?.outputTokens ?? 0,
      estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0,
    };
    await input.onModelResponse?.(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if ((input.failedFoldAttempts ?? 0) >= 1)
      return performDegradedFold(input, plan, beforeConversationBytes, reason);
    return {
      outcome: "failed",
      reason,
    };
  }

  const rawNarrative = (content ?? "").trim();
  if (!rawNarrative) {
    if ((input.failedFoldAttempts ?? 0) >= 1)
      return performDegradedFold(
        input,
        plan,
        beforeConversationBytes,
        "empty_summary",
      );
    return { outcome: "failed", reason: "empty_summary" };
  }
  const clippedNarrative = clipUtf8WithSuffix(
    rawNarrative,
    narrativeBudgetBytes,
    "\n[Narrative clipped; see Trace.]",
  );
  const narrative = clippedNarrative.text;

  const ledger = buildFactLedger(plan.foldTurns, input.rollingSummary?.ledger);
  const text = `${narrative}\n\n${renderFactLedger(ledger, {
    maxConversationBytes: input.maxConversationBytes,
  })}`;
  input.conversation.splice(0, input.conversation.length, ...plan.keptTurns);

  return {
    outcome: "folded",
    rollingSummary: { text, ledger },
    usage,
    trace: {
      beforeConversationBytes,
      afterConversationBytes:
        conversationBudgetBytes(plan.keptTurns, text),
      foldedTurnCount: plan.foldTurns.filter(
        (message) => message.role === "assistant",
      ).length,
      narrativeClipped: clippedNarrative.clipped,
      text,
    },
  };
}

function performDegradedFold(
  input: FoldAttemptInput,
  plan: Extract<ReturnType<typeof planFold>, { action: "fold" }>,
  beforeConversationBytes: number,
  reason: string,
): FoldAttemptResult {
  const failedAttemptCount = (input.failedFoldAttempts ?? 0) + 1;
  const priorNarrative = narrativeFromSummaryText(input.rollingSummary?.text);
  const degradedNarrative = [
    priorNarrative,
    `Degraded Fold: summarization failed after ${failedAttemptCount} consecutive attempts (${reason}); see Trace for the folded turns and deterministic Fact Ledger evidence.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const clippedNarrative = clipUtf8WithSuffix(
    degradedNarrative,
    subBudgetBytes(input.maxConversationBytes, NARRATIVE_BUDGET_RATIO),
    "\n[Narrative clipped; see Trace.]",
  );
  const ledger = buildFactLedger(plan.foldTurns, input.rollingSummary?.ledger);
  const text = `${clippedNarrative.text}\n\n${renderFactLedger(ledger, {
    maxConversationBytes: input.maxConversationBytes,
  })}`;
  input.conversation.splice(0, input.conversation.length, ...plan.keptTurns);

  return {
    outcome: "folded",
    rollingSummary: { text, ledger },
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    trace: {
      beforeConversationBytes,
      afterConversationBytes: conversationBudgetBytes(plan.keptTurns, text),
      foldedTurnCount: plan.foldTurns.filter(
        (message) => message.role === "assistant",
      ).length,
      narrativeClipped: clippedNarrative.clipped,
      degraded: true,
      reason,
      failedAttemptCount,
      text,
    },
  };
}

export function rollingSummaryMessage(
  rollingSummary: RollingSummaryState | undefined,
): ModelMessage | undefined {
  if (!rollingSummary) return undefined;
  return {
    role: "user",
    content: rollingSummaryContent(rollingSummary.text),
  };
}

function buildSummarizationMessages(
  previousSummaryText: string | undefined,
  foldTurns: ModelMessage[],
  narrativeBudgetBytes: number,
): ModelMessage[] {
  const wordBudget = Math.max(1, Math.floor(narrativeBudgetBytes / 6));
  return [
    {
      role: "system",
      content: [
        "You are maintaining a Rolling Summary for a long-running Forgelet Session.",
        "Write a concise narrative of the work completed in the turns below, preserving task continuity.",
        `Hard limit: the narrative must fit within ${narrativeBudgetBytes} bytes, roughly ${wordBudget} words, which is 25% of the active conversation budget.`,
        "Deterministic facts (file paths, hashes, ranges, exit codes) are tracked separately in a Fact Ledger; do not restate raw file contents or command output verbatim.",
        "Do not copy or imitate the Fact Ledger section in your narrative; the ledger is appended separately, so never fabricate a 'Fact Ledger' heading, hashes, or entries.",
      ].join("\n"),
    },
    ...(previousSummaryText
      ? [
          {
            role: "user" as const,
            content: `Existing Rolling Summary:\n${previousSummaryText}`,
          },
        ]
      : []),
    ...foldTurns,
    {
      role: "user",
      content:
        "Summarize the turns above into an updated Rolling Summary narrative. Be concise and focus on task progress and decisions.",
    },
  ];
}

function narrativeFromSummaryText(text: string | undefined): string {
  if (!text) return "";
  const marker = "\n\nFact Ledger:";
  const markerIndex = text.indexOf(marker);
  return markerIndex === -1 ? text : text.slice(0, markerIndex);
}
