import { createHash } from "node:crypto";
import type { SuggestionRecord } from "./records.js";

export interface RenderedMemoryBlock {
  bytes: string;
  byteCount: number;
  sha256: string;
  finalNewline: true;
}

type RenderableSuggestion = Pick<
  SuggestionRecord,
  "id" | "text" | "sourceSessionId" | "reason"
>;

/** The sole renderer for the immutable suggestion bytes that show previews
 * and a later acceptance writes. File-boundary spacing is deliberately not
 * represented here. */
export function renderMemoryBlock(
  suggestion: RenderableSuggestion,
): RenderedMemoryBlock {
  const legacyReason = typeof suggestion.reason === "string"
    ? suggestion.reason
    : undefined;
  const lines = [
    `## ${suggestion.id}`,
    "",
    suggestion.text,
    "",
    `Source Session: ${suggestion.sourceSessionId}`,
    ...(legacyReason === undefined ? [] : [`Reason: ${legacyReason}`]),
    "",
  ];
  const bytes = lines.join("\n");
  return {
    bytes,
    byteCount: Buffer.byteLength(bytes, "utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    finalNewline: true,
  };
}
