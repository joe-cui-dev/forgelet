import type { CapturedMemory } from "../../memory/index.js";
import type { FrictionSignal } from "../../memory/frictionSignal.js";
import { formatFrictionSignalsForHuman } from "../../memory/frictionSignal.js";
import type {
  MemoryReviewItem,
  MemoryReviewList,
  MemoryReviewShowResult,
  TraceCorroboration,
} from "../../memoryReview/index.js";
import type { MemoryDecisionResult } from "../../memoryReview/decide.js";
import { MEMORY_DECISIONS_RELATIVE_PATH } from "../../memoryReview/records.js";

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

/** The receipt for a capture — `forge memory add` or the Session-end prompt:
 * one line per recorded suggestion, distinguishing a new proposal from a line
 * this Session already carried. */
export function formatMemoryCapture(
  sessionId: string,
  captured: CapturedMemory[],
): string {
  if (captured.length === 0)
    return `Nothing captured for Session ${sessionId}.`;
  const created = captured.filter((entry) => entry.outcome === "created").length;
  const existing = captured.length - created;
  const lines = [
    `Captured ${created} new Memory Suggestion${created === 1 ? "" : "s"}` +
      (existing > 0 ? ` (${existing} already recorded)` : "") +
      ` for Session ${sessionId}:`,
  ];
  for (const { suggestion, outcome } of captured) {
    lines.push(
      `- ${suggestion.id} (${outcome === "created" ? "new" : "existing"} proposal)`,
      `  ${suggestion.text}`,
    );
  }
  lines.push("Review with: forge memory list");
  return lines.join("\n");
}

/** The friction block shown before the Session-end capture prompt, and printed
 * into a non-TTY Session's final output so it survives for later backfill
 * (ADR 0076). */
export function formatSessionFriction(signals: FrictionSignal[]): string[] {
  if (signals.length === 0) return [];
  return ["This Session hit friction:", ...formatFrictionSignalsForHuman(signals)];
}

/** The non-TTY tail: the friction points plus how to record a memory later,
 * appended to the Session output when the capture prompt cannot run. */
export function formatNonInteractiveCaptureHint(
  sessionId: string,
  signals: FrictionSignal[],
): string {
  return [
    ...formatSessionFriction(signals),
    `If any of that is worth remembering, add it with: forge memory add --session ${sessionId} "..."`,
  ].join("\n");
}

/** Concise, evidence-aware receipt for `forge memory accept|reject`: leads
 * with the outcome, names the Durable Memory write when one happened, and
 * always points at the Memory Decision Log as the evidence of record. */
export function formatMemoryDecisionReceipt(result: MemoryDecisionResult): string {
  const verb = result.action === "accepted" ? "Accepted" : "Rejected";
  const lines = [`${verb}: ${result.suggestionId}`];
  switch (result.outcome) {
    case "decided":
      lines.push(`Decided at ${result.decidedAt}.`);
      break;
    case "repeated":
      lines.push(`Already decided at ${result.decidedAt}.`);
      break;
    case "repaired":
      lines.push(`Decision recorded at ${result.decidedAt}; repaired the missing Durable Memory write.`);
      break;
  }
  if (result.write) {
    lines.push(
      `Durable Memory: ${result.write.path} (${result.write.blockBytes} bytes, sha256 ${result.write.blockHash})`,
    );
  }
  lines.push(`Evidence: ${MEMORY_DECISIONS_RELATIVE_PATH}`);
  return lines.join("\n");
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
  if (result.state === "proposed") {
    lines.push(
      `Accept: forge memory accept ${suggestion.id}`,
      `Reject: forge memory reject ${suggestion.id}`,
    );
  } else if (result.state === "accepted-unwritten") {
    lines.push(`Repair the write: forge memory accept ${suggestion.id}`);
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
