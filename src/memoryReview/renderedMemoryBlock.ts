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
  "id" | "text" | "sourceSessionId"
>;

/** The trailing provenance marker that carries a Rendered Memory Block's
 * identity in the flattened single-bullet shape (WP7, ADR 0075/0076). It is an
 * HTML comment so it is invisible in rendered Markdown yet present in the file
 * a human edits and in the whole-file injection, keeping every entry traceable
 * to its source Session and locatable by `findExistingMemoryBlock`. */
export function memoryBlockMarker(id: string, sourceSessionId: string): string {
  return `<!-- forgelet-memory ${id} source:${sourceSessionId} -->`;
}

/** The prefix of a marker for a given suggestion id, used to locate an already
 * written block regardless of its source Session. */
export function memoryBlockMarkerPrefix(id: string): string {
  return `<!-- forgelet-memory ${id} `;
}

/** The sole renderer for the immutable suggestion bytes that show previews and
 * a later acceptance writes. A Rendered Memory Block is a single Markdown
 * bullet with its provenance trailing in an HTML comment (WP7), matching the
 * hand-maintained shape in `.forgelet/memory.md` and cutting the noise that
 * whole-file injection (ADR 0032, ADR 0064) put in front of every later
 * Session. File-boundary spacing is deliberately not represented here. */
export function renderMemoryBlock(
  suggestion: RenderableSuggestion,
): RenderedMemoryBlock {
  const bytes = `- ${suggestion.text} ${memoryBlockMarker(
    suggestion.id,
    suggestion.sourceSessionId,
  )}\n`;
  return {
    bytes,
    byteCount: Buffer.byteLength(bytes, "utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    finalNewline: true,
  };
}
