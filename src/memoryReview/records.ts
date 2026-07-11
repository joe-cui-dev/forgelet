import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MEMORY_SUGGESTIONS_RELATIVE_PATH =
  ".forgelet/memory-suggestions.jsonl";
export const MEMORY_DECISIONS_RELATIVE_PATH =
  ".forgelet/memory-decisions.jsonl";

export type LegacySuggestionStatus = "proposed" | "accepted" | "rejected";

/** One validated Memory Suggestion record. `legacyStatus` is migration input
 * only (v0 records); derived status always comes from the Memory Decision
 * Log. `createdAt` is absent when the record predates the versioned schema. */
export interface SuggestionRecord {
  id: string;
  sourceSessionId: string;
  text: string;
  createdAt?: string;
  legacyStatus?: LegacySuggestionStatus;
  /** Legacy reason and versioned provenance are immutable record evidence. */
  reason?: string;
  provenance?: unknown;
  /** Evidence location, retained so read-model errors identify corrupt input. */
  sourceLine: number;
}

export interface MemoryDecisionRecord {
  type: "decision";
  suggestionId: string;
  decision: "accepted" | "rejected";
  [key: string]: unknown;
}

export interface MemoryWriteRecord {
  type: "write-record";
  suggestionId: string;
  [key: string]: unknown;
}

export type DecisionLogRecord = MemoryDecisionRecord | MemoryWriteRecord;

export interface FoldedDecisionLog {
  /** First Memory Decision per suggestion id — first record wins. */
  firstDecisionById: Map<string, MemoryDecisionRecord>;
  /** Suggestion ids with at least one Memory Write Record. */
  writtenIds: Set<string>;
  /** First write evidence per suggestion id, retained for `show`. */
  firstWriteById: Map<string, MemoryWriteRecord>;
}

/** Folds the append-only Memory Decision Log into the two lookups every
 * derivation needs: the winning first decision per id, and which accepted
 * suggestions have a confirmed write. */
export function foldDecisionLog(log: DecisionLogRecord[]): FoldedDecisionLog {
  const firstDecisionById = new Map<string, MemoryDecisionRecord>();
  const writtenIds = new Set<string>();
  const firstWriteById = new Map<string, MemoryWriteRecord>();
  for (const record of log) {
    if (record.type === "decision" && !firstDecisionById.has(record.suggestionId))
      firstDecisionById.set(record.suggestionId, record);
    if (record.type === "write-record") {
      writtenIds.add(record.suggestionId);
      if (!firstWriteById.has(record.suggestionId))
        firstWriteById.set(record.suggestionId, record);
    }
  }
  return { firstDecisionById, writtenIds, firstWriteById };
}

const PREVIEW_MAX_CHARS = 160;

/** The short single-line form of a suggestion text, shared by list rows and
 * the textPreview evidence inside Memory Decision records. */
export function singleLinePreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? `${normalized.slice(0, PREVIEW_MAX_CHARS - 3)}...`
    : normalized;
}

export async function readSuggestionRecords(
  workspaceRoot: string,
): Promise<SuggestionRecord[]> {
  const lines = await readJsonlLines(
    workspaceRoot,
    MEMORY_SUGGESTIONS_RELATIVE_PATH,
  );
  return lines.map(({ value, lineNumber }) =>
    validateSuggestionRecord(value, lineNumber),
  );
}

export async function readDecisionLogRecords(
  workspaceRoot: string,
): Promise<DecisionLogRecord[]> {
  const lines = await readJsonlLines(
    workspaceRoot,
    MEMORY_DECISIONS_RELATIVE_PATH,
  );
  return lines.map(({ value, lineNumber }) =>
    validateDecisionLogRecord(value, lineNumber),
  );
}

interface JsonlLine {
  value: unknown;
  lineNumber: number;
}

async function readJsonlLines(
  workspaceRoot: string,
  relativePath: string,
): Promise<JsonlLine[]> {
  let content: string;
  try {
    content = await readFile(join(workspaceRoot, relativePath), "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const parsed: JsonlLine[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) continue;
    const lineNumber = index + 1;
    try {
      parsed.push({ value: JSON.parse(line), lineNumber });
    } catch {
      throw new Error(
        `Malformed JSON in ${relativePath} at line ${lineNumber}`,
      );
    }
  }
  return parsed;
}

function validateSuggestionRecord(
  value: unknown,
  lineNumber: number,
): SuggestionRecord {
  const fail = (problem: string): never => {
    throw new Error(
      `Invalid memory suggestion record (${problem}) in ${MEMORY_SUGGESTIONS_RELATIVE_PATH} at line ${lineNumber}`,
    );
  };
  if (!isRecord(value)) return fail("not an object");

  if (!("schemaVersion" in value)) {
    // Legacy v0: must completely match the old shape.
    if (
      typeof value.id !== "string" ||
      typeof value.sourceSessionId !== "string" ||
      typeof value.text !== "string" ||
      typeof value.reason !== "string" ||
      !isLegacyStatus(value.status)
    ) {
      return fail("does not match the legacy record shape");
    }
    return {
      id: value.id,
      sourceSessionId: value.sourceSessionId,
      text: value.text,
      legacyStatus: value.status,
      reason: value.reason,
      sourceLine: lineNumber,
    };
  }

  if (value.schemaVersion !== 1) {
    throw new Error(
      `Unknown memory suggestion schema version ${JSON.stringify(value.schemaVersion)} in ${MEMORY_SUGGESTIONS_RELATIVE_PATH} at line ${lineNumber}`,
    );
  }
  if (
    typeof value.id !== "string" ||
    typeof value.sourceSessionId !== "string" ||
    typeof value.text !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return fail("missing required versioned fields");
  }
  return {
    id: value.id,
    sourceSessionId: value.sourceSessionId,
    text: value.text,
    createdAt: value.createdAt,
    ...("provenance" in value ? { provenance: value.provenance } : {}),
    sourceLine: lineNumber,
  };
}

function validateDecisionLogRecord(
  value: unknown,
  lineNumber: number,
): DecisionLogRecord {
  const fail = (problem: string): never => {
    throw new Error(
      `Invalid memory decision log record (${problem}) in ${MEMORY_DECISIONS_RELATIVE_PATH} at line ${lineNumber}`,
    );
  };
  if (!isRecord(value)) return fail("not an object");

  // Untyped legacy records are Memory Decisions.
  const type = "type" in value ? value.type : "decision";
  if (type === "decision") {
    if (typeof value.suggestionId !== "string")
      return fail("missing suggestionId");
    if (value.decision !== "accepted" && value.decision !== "rejected")
      return fail("decision must be accepted or rejected");
    return { ...value, type: "decision", suggestionId: value.suggestionId, decision: value.decision };
  }
  if (type === "write-record") {
    if (typeof value.suggestionId !== "string")
      return fail("missing suggestionId");
    return { ...value, type: "write-record", suggestionId: value.suggestionId };
  }
  return fail(`unknown record type ${JSON.stringify(type)}`);
}

function isLegacyStatus(value: unknown): value is LegacySuggestionStatus {
  return value === "proposed" || value === "accepted" || value === "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
