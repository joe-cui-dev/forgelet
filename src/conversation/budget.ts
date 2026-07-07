import type { ModelMessage } from "../types.js";

export const ROLLING_SUMMARY_PREFIX =
  "Rolling Summary (earlier turns folded to stay within budget):\n";
export const LOW_WATER_RATIO = 0.5;
export const NARRATIVE_BUDGET_RATIO = 0.25;
export const FACT_LEDGER_BUDGET_RATIO = 0.25;

export function messageBytes(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + byteLengthUtf8(message.content),
    0,
  );
}

export function conversationBudgetBytes(
  conversation: ModelMessage[],
  rollingSummaryText?: string,
): number {
  return (
    messageBytes(conversation) +
    (rollingSummaryText ? rollingSummaryContentBytes(rollingSummaryText) : 0)
  );
}

export function rollingSummaryContent(text: string): string {
  return `${ROLLING_SUMMARY_PREFIX}${text}`;
}

export function rollingSummaryContentBytes(text: string): number {
  return byteLengthUtf8(rollingSummaryContent(text));
}

export function byteLengthUtf8(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function subBudgetBytes(maxConversationBytes: number, ratio: number) {
  return Math.floor(maxConversationBytes * ratio);
}

export function clipUtf8WithSuffix(
  value: string,
  maxBytes: number,
  suffix: string,
): { text: string; clipped: boolean } {
  if (byteLengthUtf8(value) <= maxBytes) return { text: value, clipped: false };
  const suffixBytes = byteLengthUtf8(suffix);
  if (suffixBytes >= maxBytes) {
    let text = "";
    for (const char of suffix) {
      if (byteLengthUtf8(text + char) > maxBytes) break;
      text += char;
    }
    return { text, clipped: true };
  }

  let text = "";
  for (const char of value) {
    if (byteLengthUtf8(text + char) + suffixBytes > maxBytes) break;
    text += char;
  }
  return { text: `${text}${suffix}`, clipped: true };
}
