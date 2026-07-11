import type { MemorySuggestion } from "../../types.js";
import type {
  MemoryReviewItem,
  MemoryReviewList,
} from "../../memoryReview/index.js";

/** Guided-review presentation: each item leads with the derived state in
 * plain language and ends with an explicit next command. */
export function formatMemoryReviewList(
  list: MemoryReviewList,
  options: { all: boolean },
): string {
  if (list.items.length === 0) {
    if (options.all) return "No memory suggestions.";
    const lines = ["No pending memory suggestions."];
    if (list.hiddenDecidedCount > 0) lines.push(decidedHint(list.hiddenDecidedCount));
    return lines.join("\n");
  }
  return list.items.map(formatReviewItem).join("\n\n");
}

function formatReviewItem(item: MemoryReviewItem): string {
  return [
    stateLead(item),
    `  "${item.preview}"`,
    `  Created: ${item.createdAt ?? "-"}   Id: ${item.id}`,
    `  Next: ${nextCommand(item)}`,
  ].join("\n");
}

function stateLead(item: MemoryReviewItem): string {
  switch (item.state) {
    case "proposed":
      return "Proposed — awaiting your review";
    case "accepted-unwritten":
      return "Accepted, but not written — re-accept to repair";
    case "accepted":
      return "Accepted and written";
    case "rejected":
      return "Rejected";
  }
}

function nextCommand(item: MemoryReviewItem): string {
  return item.state === "accepted-unwritten"
    ? `forge memory accept ${item.id}`
    : `forge memory show ${item.id}`;
}

function decidedHint(count: number): string {
  return count === 1
    ? "1 decided suggestion recorded. Run forge memory list --all to include it."
    : `${count} decided suggestions recorded. Run forge memory list --all to include them.`;
}

export function formatMemorySuggestion(suggestion: MemorySuggestion): string {
  return [
    `Memory suggestion: ${suggestion.id}`,
    `Source Session: ${suggestion.sourceSessionId}`,
    `Status: ${suggestion.status}`,
    `Reason: ${suggestion.reason}`,
    suggestion.text,
  ].join("\n");
}

export function formatAcceptedMemory(suggestion: MemorySuggestion): string {
  return [
    `Memory accepted: ${suggestion.id}`,
    `Source Session: ${suggestion.sourceSessionId}`,
  ].join("\n");
}
