import { ensureCompatibilityImport } from "./compatibilityImport.js";
import {
  foldDecisionLog,
  readDecisionLogRecords,
  readSuggestionRecords,
  singleLinePreview,
} from "./records.js";

export type MemoryReviewState =
  | "proposed"
  | "accepted"
  | "accepted-unwritten"
  | "rejected";

export interface MemoryReviewItem {
  id: string;
  state: MemoryReviewState;
  createdAt?: string;
  preview: string;
}

export interface MemoryReviewList {
  items: MemoryReviewItem[];
  /** Decided suggestions hidden by the default actionable scope; always 0
   * when listing everything. Lets presentation show that history exists. */
  hiddenDecidedCount: number;
}

export interface ListMemoryReviewOptions {
  all: boolean;
}

/** The Project Memory Review read model behind `forge memory list`: runs the
 * Compatibility Import once, then derives every state from the append-only
 * suggestions file and Memory Decision Log (first decision per id wins).
 * Performs zero Trace IO and starts no model-backed Workflow. */
export async function listMemoryReview(
  workspaceRoot: string,
  options: ListMemoryReviewOptions,
): Promise<MemoryReviewList> {
  await ensureCompatibilityImport(workspaceRoot);
  const suggestions = await readSuggestionRecords(workspaceRoot);
  const { firstDecisionById, writtenIds } = foldDecisionLog(
    await readDecisionLogRecords(workspaceRoot),
  );

  const items: MemoryReviewItem[] = [];
  let hiddenDecidedCount = 0;
  for (const suggestion of suggestions) {
    const state = deriveState(
      firstDecisionById.get(suggestion.id)?.decision,
      writtenIds.has(suggestion.id),
    );
    const actionable = state === "proposed" || state === "accepted-unwritten";
    if (!options.all && !actionable) {
      hiddenDecidedCount += 1;
      continue;
    }
    items.push({
      id: suggestion.id,
      state,
      ...(suggestion.createdAt === undefined
        ? {}
        : { createdAt: suggestion.createdAt }),
      preview: singleLinePreview(suggestion.text),
    });
  }
  return { items, hiddenDecidedCount };
}

function deriveState(
  decision: "accepted" | "rejected" | undefined,
  written: boolean,
): MemoryReviewState {
  if (decision === undefined) return "proposed";
  if (decision === "rejected") return "rejected";
  return written ? "accepted" : "accepted-unwritten";
}
