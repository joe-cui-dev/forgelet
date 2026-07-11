import type { MemorySuggestion } from "../../types.js";
import type {
  MemoryReviewItem,
  MemoryReviewList,
  MemoryReviewShowResult,
  TraceCorroboration,
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

/** Guided evidence view: the decision path stays readable while every stored
 * field remains inspectable below it. */
export function formatMemoryReviewShow(result: MemoryReviewShowResult): string {
  if (result.kind === "orphan-decision") {
    return [
      "Suggestion record missing",
      "",
      "Memory Decision evidence",
      ...formatDecision(result.decision),
      ...(result.writeRecord === undefined ? [] : ["", "Memory Write Record evidence", ...formatWriteRecord(result.writeRecord)]),
    ].join("\n");
  }

  const { suggestion } = result;
  const lines = [
    "What Forgelet wants to remember",
    suggestion.text,
    "",
    "Why it was suggested",
    ...formatProvenance(suggestion.provenance, suggestion.legacyStatus !== undefined),
    `Trace Corroboration: ${formatCorroboration(result.traceCorroboration)}`,
    "",
    "Exactly what acceptance will add",
  ];
  if (result.renderedBlock) {
    lines.push(
      `Destination: ${result.destination}`,
      `Rendered Memory Block: ${result.renderedBlock.byteCount} bytes, sha256 ${result.renderedBlock.sha256}, final newline: yes`,
      "--- begin rendered memory block ---",
      result.renderedBlock.bytes.slice(0, -1),
      "--- end rendered memory block ---",
    );
  } else if (result.decision) {
    lines.push("No current render: settled evidence is authoritative.", ...formatDecision(result.decision));
    if (result.writeRecord) lines.push("Memory Write Record evidence", ...formatWriteRecord(result.writeRecord));
  } else {
    lines.push("No write evidence is available.");
  }
  lines.push("", "Your choice");
  if (suggestion.legacyStatus === "proposed" && result.state === "proposed") {
    lines.push(`Accept this suggestion: forge memory accept ${suggestion.id}`);
  } else if (result.state === "proposed" || result.state === "accepted-unwritten") {
    lines.push("This is an evidence-only view; Project Memory Review decisions are not available yet.");
  } else {
    lines.push("This suggestion is already settled.");
  }
  lines.push(
    "",
    `Id: ${suggestion.id}   Status: ${stateLabel(result.state)}   Created: ${suggestion.createdAt ?? "-"}`,
    `Source Session: ${suggestion.sourceSessionId}`,
  );
  return lines.join("\n");
}

function formatProvenance(provenance: unknown, legacy: boolean): string[] {
  if (legacy) return ["Provenance: Unavailable (legacy record)"];
  if (!isRecord(provenance)) return ["Provenance Snapshot: Unavailable"];
  return ["Provenance Snapshot:", JSON.stringify(provenance, null, 2)];
}

function formatCorroboration(corroboration: TraceCorroboration | undefined): string {
  return corroboration ?? "Not available";
}

function formatDecision(decision: Record<string, unknown>): string[] {
  return Object.entries(decision).map(([key, value]) => `${key}: ${formatEvidence(value)}`);
}

function formatWriteRecord(record: Record<string, unknown>): string[] {
  return Object.entries(record).map(([key, value]) => `${key}: ${formatEvidence(value)}`);
}

function formatEvidence(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stateLabel(state: MemoryReviewItem["state"]): string {
  return state === "accepted-unwritten" ? "accepted (unwritten)" : state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
