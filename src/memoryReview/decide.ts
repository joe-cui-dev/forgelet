import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertCompleteProvenance, corroborateTrace } from "./index.js";
import { runCompatibilityImportLocked } from "./compatibilityImport.js";
import {
  findExistingMemoryBlock,
  resolveDurableMemoryDestination,
  type DurableMemoryDestination,
} from "./durableMemoryDestination.js";
import { withMemoryDecisionLock } from "./lock.js";
import {
  MEMORY_DECISIONS_RELATIVE_PATH,
  foldDecisionLog,
  readDecisionLogRecords,
  readSuggestionRecords,
  singleLinePreview,
  type DecisionLogRecord,
  type MemoryDecisionRecord,
  type MemoryWriteRecord,
  type SuggestionRecord,
} from "./records.js";
import { renderMemoryBlock, type RenderedMemoryBlock } from "./renderedMemoryBlock.js";

export type MemoryDecisionAction = "accepted" | "rejected";

/** `decided`: a fresh Memory Decision was appended. `repeated`: the same
 * terminal decision already existed and nothing new was appended. `repaired`:
 * an existing acceptance had no Memory Write Record, and this call closed
 * that Memory Write Gap without appending a second decision. */
export type MemoryDecisionOutcome = "decided" | "repeated" | "repaired";

export interface MemoryDecisionWriteEvidence {
  path: string;
  blockHash: string;
  blockBytes: number;
}

export interface MemoryDecisionResult {
  suggestionId: string;
  action: MemoryDecisionAction;
  outcome: MemoryDecisionOutcome;
  decidedAt: string;
  write?: MemoryDecisionWriteEvidence;
}

export interface DecideMemorySuggestionOptions {
  now?: () => Date;
}

/** Deterministic, model-free Project Memory Review decisions. Both accept and
 * reject share one advisory lock (ADR 0035): inside it Forgelet runs the
 * Compatibility Import, derives current state from the append-only evidence,
 * appends the Memory Decision as the commit point, then — for an acceptance —
 * writes Durable Memory and appends a Memory Write Record only after the
 * write succeeds. */
export async function acceptMemorySuggestion(
  workspaceRoot: string,
  suggestionId: string,
  options: DecideMemorySuggestionOptions = {},
): Promise<MemoryDecisionResult> {
  return decideMemorySuggestion(workspaceRoot, suggestionId, "accepted", options);
}

export async function rejectMemorySuggestion(
  workspaceRoot: string,
  suggestionId: string,
  options: DecideMemorySuggestionOptions = {},
): Promise<MemoryDecisionResult> {
  return decideMemorySuggestion(workspaceRoot, suggestionId, "rejected", options);
}

async function decideMemorySuggestion(
  workspaceRoot: string,
  suggestionId: string,
  action: MemoryDecisionAction,
  options: DecideMemorySuggestionOptions,
): Promise<MemoryDecisionResult> {
  const now = options.now ?? (() => new Date());

  return withMemoryDecisionLock(workspaceRoot, async () => {
    await runCompatibilityImportLocked(workspaceRoot, { now });

    const suggestions = await readSuggestionRecords(workspaceRoot);
    const suggestion = suggestions.find((entry) => entry.id === suggestionId);
    const log = foldDecisionLog(await readDecisionLogRecords(workspaceRoot));
    const existing = log.firstDecisionById.get(suggestionId);

    if (!suggestion) {
      if (!existing) throw new Error(`Memory suggestion not found: ${suggestionId}`);
      return resolveOrphanDecision(existing, log, action);
    }

    assertCompleteProvenance(suggestion);

    if (existing) {
      if (existing.decision !== action) throw conflictError(suggestionId, existing, action);
      const decidedAt = decidedAtOf(existing);
      if (action === "rejected") {
        return { suggestionId, action, outcome: "repeated", decidedAt };
      }
      const priorWrite = log.firstWriteById.get(suggestionId);
      if (priorWrite) {
        return {
          suggestionId,
          action,
          outcome: "repeated",
          decidedAt,
          write: writeEvidenceFrom(priorWrite),
        };
      }
      const write = await writeAcceptedBlock(workspaceRoot, suggestion, now);
      return { suggestionId, action, outcome: "repaired", decidedAt, write };
    }

    const decidedAt = now().toISOString();
    const corroboration = await corroborateTrace(workspaceRoot, suggestion);
    const destination =
      action === "accepted" ? await resolveDurableMemoryDestination(workspaceRoot) : undefined;
    const rendered = action === "accepted" ? renderMemoryBlock(suggestion) : undefined;

    const decisionRecord: MemoryDecisionRecord = {
      type: "decision",
      suggestionId,
      decision: action,
      decidedAt,
      sourceSessionId: suggestion.sourceSessionId,
      textHash: createHash("sha256").update(suggestion.text).digest("hex"),
      textPreview: singleLinePreview(suggestion.text),
      ...(corroboration === undefined ? {} : { traceCorroboration: corroboration }),
      ...(destination && rendered
        ? {
            intendedPath: destination.displayPath,
            intendedBlockHash: rendered.sha256,
            intendedBlockBytes: rendered.byteCount,
          }
        : {}),
    };
    await appendDecisionLogRecords(workspaceRoot, [decisionRecord]);

    if (action === "rejected") {
      return { suggestionId, action, outcome: "decided", decidedAt };
    }

    const write = await writeAcceptedBlock(workspaceRoot, suggestion, now, {
      destination: destination!,
      rendered: rendered!,
    });
    return { suggestionId, action, outcome: "decided", decidedAt, write };
  });
}

async function writeAcceptedBlock(
  workspaceRoot: string,
  suggestion: SuggestionRecord,
  now: () => Date,
  precomputed?: { destination: DurableMemoryDestination; rendered: RenderedMemoryBlock },
): Promise<MemoryDecisionWriteEvidence> {
  const destination = precomputed?.destination ?? (await resolveDurableMemoryDestination(workspaceRoot));
  const rendered = precomputed?.rendered ?? renderMemoryBlock(suggestion);

  const existingBlock = await findExistingMemoryBlock(destination.absolutePath, suggestion.id);
  if (existingBlock) {
    const writeRecord: MemoryWriteRecord = {
      type: "write-record",
      suggestionId: suggestion.id,
      origin: "found-existing",
      path: destination.displayPath,
      blockHash: existingBlock.blockHash,
      blockBytes: existingBlock.blockBytes,
      observedAt: now().toISOString(),
    };
    await appendDecisionLogRecords(workspaceRoot, [writeRecord]);
    return {
      path: destination.displayPath,
      blockHash: existingBlock.blockHash,
      blockBytes: existingBlock.blockBytes,
    };
  }

  await mkdir(dirname(destination.absolutePath), { recursive: true });
  await appendFile(destination.absolutePath, rendered.bytes, "utf8");
  const writeRecord: MemoryWriteRecord = {
    type: "write-record",
    suggestionId: suggestion.id,
    path: destination.displayPath,
    blockHash: rendered.sha256,
    blockBytes: rendered.byteCount,
    writtenAt: now().toISOString(),
  };
  await appendDecisionLogRecords(workspaceRoot, [writeRecord]);
  return { path: destination.displayPath, blockHash: rendered.sha256, blockBytes: rendered.byteCount };
}

function resolveOrphanDecision(
  existing: MemoryDecisionRecord,
  log: { firstWriteById: Map<string, MemoryWriteRecord> },
  action: MemoryDecisionAction,
): MemoryDecisionResult {
  if (existing.decision !== action) throw conflictError(existing.suggestionId, existing, action);
  const write = log.firstWriteById.get(existing.suggestionId);
  return {
    suggestionId: existing.suggestionId,
    action,
    outcome: "repeated",
    decidedAt: decidedAtOf(existing),
    ...(write ? { write: writeEvidenceFrom(write) } : {}),
  };
}

async function appendDecisionLogRecords(
  workspaceRoot: string,
  records: DecisionLogRecord[],
): Promise<void> {
  const path = join(workspaceRoot, MEMORY_DECISIONS_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
}

function conflictError(
  suggestionId: string,
  existing: MemoryDecisionRecord,
  attempted: MemoryDecisionAction,
): Error {
  return new Error(
    `Memory suggestion ${suggestionId} was already ${existing.decision} at ${decidedAtOf(existing)}; cannot ${
      attempted === "accepted" ? "accept" : "reject"
    } it.`,
  );
}

function decidedAtOf(decision: MemoryDecisionRecord): string {
  const value = decision.decidedAt ?? decision.importedAt;
  return typeof value === "string" ? value : "an unknown time";
}

function writeEvidenceFrom(record: MemoryWriteRecord): MemoryDecisionWriteEvidence {
  return {
    path: typeof record.path === "string" ? record.path : "",
    blockHash: typeof record.blockHash === "string" ? record.blockHash : "",
    blockBytes: typeof record.blockBytes === "number" ? record.blockBytes : 0,
  };
}
