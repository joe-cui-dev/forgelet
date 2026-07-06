import type { ModelMessage } from "../types.js";

export interface FoldPlanInput {
  maxConversationBytes: number;
  protectedRecentTurns: number;
  rollingSummaryBytes: number;
}

export type FoldPlan =
  | { action: "none" }
  | { action: "stop" }
  | { action: "fold"; foldTurns: ModelMessage[]; keptTurns: ModelMessage[] };

const LOW_WATER_RATIO = 0.5;

export function planFold(
  turns: ModelMessage[],
  input: FoldPlanInput,
): FoldPlan {
  const totalBytes = messageBytes(turns) + input.rollingSummaryBytes;
  if (totalBytes <= input.maxConversationBytes) return { action: "none" };

  const groups = groupIntoTurns(turns);
  const protectedGroups = groups.slice(
    Math.max(0, groups.length - input.protectedRecentTurns),
  );
  const foldableGroups = groups.slice(
    0,
    groups.length - protectedGroups.length,
  );
  if (foldableGroups.length === 0)
    return input.rollingSummaryBytes > 0
      ? { action: "stop" }
      : { action: "none" };

  const lowWaterBytes = input.maxConversationBytes * LOW_WATER_RATIO;
  const protectedBytes = messageBytes(protectedGroups.flat());
  const remaining = [...foldableGroups];
  const folded: ModelMessage[][] = [];
  while (
    remaining.length > 0 &&
    (folded.length === 0 ||
      messageBytes(remaining.flat()) + protectedBytes > lowWaterBytes)
  ) {
    const next = remaining.shift();
    if (next) folded.push(next);
  }

  return {
    action: "fold",
    foldTurns: folded.flat(),
    keptTurns: [...remaining.flat(), ...protectedGroups.flat()],
  };
}

function groupIntoTurns(messages: ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  for (const message of messages) {
    if (message.role === "assistant") groups.push([message]);
    else groups[groups.length - 1]?.push(message);
  }
  return groups;
}

function messageBytes(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + Buffer.byteLength(message.content, "utf8"),
    0,
  );
}
