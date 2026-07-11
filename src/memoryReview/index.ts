import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ensureCompatibilityImport } from "./compatibilityImport.js";
import { resolveDurableMemoryDestination } from "./durableMemoryDestination.js";
import {
  foldDecisionLog,
  readDecisionLogRecords,
  readSuggestionRecords,
  singleLinePreview,
  MEMORY_SUGGESTIONS_RELATIVE_PATH,
  type MemoryDecisionRecord,
  type MemoryWriteRecord,
  type SuggestionRecord,
} from "./records.js";
import { renderMemoryBlock, type RenderedMemoryBlock } from "./renderedMemoryBlock.js";

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

export type TraceCorroboration = "verified" | "differs" | "missing" | "unreadable";

export interface MemoryReviewShow {
  kind: "suggestion";
  suggestion: SuggestionRecord;
  state: MemoryReviewState;
  traceCorroboration?: TraceCorroboration;
  destination?: string;
  renderedBlock?: RenderedMemoryBlock;
  decision?: MemoryDecisionRecord;
  writeRecord?: MemoryWriteRecord;
}

export interface OrphanMemoryDecisionShow {
  kind: "orphan-decision";
  decision: MemoryDecisionRecord;
  writeRecord?: MemoryWriteRecord;
}

export type MemoryReviewShowResult = MemoryReviewShow | OrphanMemoryDecisionShow;

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

/** The evidence read model behind `forge memory show`. It reads the source
 * Trace only to corroborate a stored snapshot, never to rebuild provenance. */
export async function showMemoryReview(
  workspaceRoot: string,
  suggestionId: string,
): Promise<MemoryReviewShowResult> {
  await ensureCompatibilityImport(workspaceRoot);
  const suggestions = await readSuggestionRecords(workspaceRoot);
  const log = foldDecisionLog(await readDecisionLogRecords(workspaceRoot));
  const suggestion = suggestions.find((entry) => entry.id === suggestionId);
  if (!suggestion) {
    const decision = log.firstDecisionById.get(suggestionId);
    if (!decision) throw new Error(`Memory suggestion not found: ${suggestionId}`);
    return {
      kind: "orphan-decision",
      decision,
      ...(log.firstWriteById.has(suggestionId)
        ? { writeRecord: log.firstWriteById.get(suggestionId) }
        : {}),
    };
  }
  assertCompleteProvenance(suggestion);

  const decision = log.firstDecisionById.get(suggestion.id);
  const state = deriveState(decision?.decision, log.writtenIds.has(suggestion.id));
  const corroboration = await corroborateTrace(workspaceRoot, suggestion);
  if (state === "accepted" || state === "rejected") {
    return {
      kind: "suggestion",
      suggestion,
      state,
      ...(corroboration === undefined ? {} : { traceCorroboration: corroboration }),
      ...(decision === undefined ? {} : { decision }),
      ...(state === "accepted" && log.firstWriteById.has(suggestion.id)
        ? { writeRecord: log.firstWriteById.get(suggestion.id) }
        : {}),
    };
  }

  return {
    kind: "suggestion",
    suggestion,
    state,
    ...(corroboration === undefined ? {} : { traceCorroboration: corroboration }),
    destination: await resolveMemoryDestination(workspaceRoot),
    renderedBlock: renderMemoryBlock(suggestion),
  };
}

async function resolveMemoryDestination(workspaceRoot: string): Promise<string> {
  return (await resolveDurableMemoryDestination(workspaceRoot)).displayPath;
}

export async function corroborateTrace(
  workspaceRoot: string,
  suggestion: SuggestionRecord,
): Promise<TraceCorroboration | undefined> {
  const provenance = suggestion.provenance;
  if (!isRecord(provenance) || !isRecord(provenance.trace)) return undefined;
  const trace = provenance.trace;
  if (typeof trace.path !== "string" || typeof trace.sha256 !== "string") return undefined;
  try {
    const bytes = await readFile(isAbsolute(trace.path) ? trace.path : join(workspaceRoot, trace.path));
    return createHash("sha256").update(bytes).digest("hex") === trace.sha256
      ? "verified"
      : "differs";
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? "missing" : "unreadable";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function assertCompleteProvenance(suggestion: SuggestionRecord): void {
  if (suggestion.legacyStatus !== undefined) return;
  const provenance = suggestion.provenance;
  if (
    !isRecord(provenance) ||
    !isRecord(provenance.derivation) ||
    !isBoundedEvidence(provenance.derivation.changedFiles) ||
    !isBoundedEvidence(provenance.derivation.successfulVerificationCommands) ||
    !isRecord(provenance.trace) ||
    typeof provenance.trace.path !== "string" ||
    typeof provenance.trace.sha256 !== "string" ||
    typeof provenance.trace.bytes !== "number" ||
    !isRecord(provenance.session) ||
    typeof provenance.session.workflow !== "string" ||
    typeof provenance.session.status !== "string" ||
    typeof provenance.session.startedAt !== "string" ||
    typeof provenance.session.finishedAt !== "string"
  ) {
    throw new Error(
      `Invalid memory suggestion record (missing complete Provenance Snapshot) in ${MEMORY_SUGGESTIONS_RELATIVE_PATH} at line ${suggestion.sourceLine}`,
    );
  }
}

function isBoundedEvidence(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.items) && typeof value.total === "number";
}

export function deriveState(
  decision: "accepted" | "rejected" | undefined,
  written: boolean,
): MemoryReviewState {
  if (decision === undefined) return "proposed";
  if (decision === "rejected") return "rejected";
  return written ? "accepted" : "accepted-unwritten";
}
