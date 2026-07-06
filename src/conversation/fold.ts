import type { ModelClient, ModelMessage } from "../types.js";
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
    ? Buffer.byteLength(input.rollingSummary.text, "utf8")
    : 0;
  const plan = planFold(input.conversation, {
    maxConversationBytes: input.maxConversationBytes,
    protectedRecentTurns: input.protectedRecentTurns,
    rollingSummaryBytes,
  });
  if (plan.action === "none") return { outcome: "none" };
  if (plan.action === "stop") return { outcome: "stop" };

  const beforeConversationBytes =
    messageBytes(input.conversation) + rollingSummaryBytes;
  const summarizationMessages = buildSummarizationMessages(
    input.rollingSummary?.text,
    plan.foldTurns,
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
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const narrative = (content ?? "").trim();
  if (!narrative) return { outcome: "failed", reason: "empty_summary" };

  const ledger = buildFactLedger(plan.foldTurns, input.rollingSummary?.ledger);
  const text = `${narrative}\n\n${renderFactLedger(ledger)}`;
  input.conversation.splice(0, input.conversation.length, ...plan.keptTurns);

  return {
    outcome: "folded",
    rollingSummary: { text, ledger },
    usage,
    trace: {
      beforeConversationBytes,
      afterConversationBytes:
        messageBytes(plan.keptTurns) + Buffer.byteLength(text, "utf8"),
      foldedTurnCount: plan.foldTurns.filter(
        (message) => message.role === "assistant",
      ).length,
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
    content: `Rolling Summary (earlier turns folded to stay within budget):\n${rollingSummary.text}`,
  };
}

function buildSummarizationMessages(
  previousSummaryText: string | undefined,
  foldTurns: ModelMessage[],
): ModelMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are maintaining a Rolling Summary for a long-running Forgelet Session.",
        "Write a concise narrative of the work completed in the turns below, preserving task continuity.",
        "Deterministic facts (file paths, hashes, ranges, exit codes) are tracked separately in a Fact Ledger; do not restate raw file contents or command output verbatim.",
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

function messageBytes(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, "utf8"),
    0,
  );
}
