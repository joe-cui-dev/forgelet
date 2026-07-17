import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig } from "../config/index.js";
import { explainSession } from "../explain/index.js";
import { runCompatibilityImportLocked } from "../memoryReview/compatibilityImport.js";
import { deriveMemoryReviewState, type MemoryReviewState } from "../memoryReview/index.js";
import { withMemoryDecisionLock } from "../memoryReview/lock.js";
import {
  foldDecisionLog,
  readDecisionLogRecords,
  readSuggestionRecords,
  type SuggestionRecord,
} from "../memoryReview/records.js";
import { findSessionTracePath, isTraceEvent, readTraceFile } from "../trace/index.js";
import type {
  BoundedMemoryEvidence,
  MemorySuggestionProvenance,
  VersionedMemorySuggestion,
} from "./types.js";

const MEMORY_SUGGESTIONS_FILE = "memory-suggestions.jsonl";
const DURABLE_MEMORY_PROMPT_LIMIT_BYTES = 20 * 1024;
const PROVENANCE_ITEM_LIMIT = 20;
const PROVENANCE_COMMAND_LIMIT = 10;
const PROVENANCE_STRING_LIMIT = 200;

export interface LoadedDurableMemory {
  path: string;
  contentBytes: number;
  returnedBytes: number;
  contentHash: string;
  preview: string;
  truncated: boolean;
  content: string;
}

export interface SuggestMemoryOptions {
  now?: () => Date;
}

export interface SuggestMemoryResult {
  suggestion: SuggestionRecord;
  state: MemoryReviewState;
  outcome: "created" | "existing";
}

export async function loadDurableMemory(
  workspaceRoot: string,
): Promise<LoadedDurableMemory | undefined> {
  const config = await loadConfig({ workspaceRoot });
  const memoryPath = resolveMemoryFile(workspaceRoot, config.memoryFile);
  try {
    const content = await readFile(memoryPath, "utf8");
    const contentBytes = Buffer.byteLength(content, "utf8");
    const returnedBytes = Math.min(contentBytes, DURABLE_MEMORY_PROMPT_LIMIT_BYTES);
    const returnedContent = Buffer.from(content, "utf8")
      .subarray(0, returnedBytes)
      .toString("utf8");
    return {
      path: config.memoryFile,
      contentBytes,
      returnedBytes,
      contentHash: createHash("sha256").update(content).digest("hex"),
      preview: makePreview(returnedContent),
      truncated: returnedBytes < contentBytes,
      content: returnedContent,
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/** Creates one immutable schema-v1 proposal, or returns the existing canonical
 * proposal for the same source Session and derived text. The append happens
 * under the shared memory lock so Compatibility Import and decision evidence
 * cannot race proposal deduplication. */
export async function suggestMemoryFromSession(
  workspaceRoot: string,
  sessionId: string,
  options: SuggestMemoryOptions = {},
): Promise<SuggestMemoryResult> {
  const now = options.now ?? (() => new Date());
  const derived = await deriveSuggestion(workspaceRoot, sessionId, now);

  return withMemoryDecisionLock(workspaceRoot, async () => {
    const existingSuggestions = await readSuggestionRecords(workspaceRoot);
    await readDecisionLogRecords(workspaceRoot);
    await runCompatibilityImportLocked(workspaceRoot, { now });
    const suggestions = await readSuggestionRecords(workspaceRoot);
    const decisionLog = foldDecisionLog(await readDecisionLogRecords(workspaceRoot));
    const existing = suggestions.find(
      (record) =>
        record.sourceSessionId === derived.sourceSessionId &&
        record.text === derived.text,
    );
    if (existing) {
      return {
        suggestion: existing,
        state: deriveMemoryReviewState(
          decisionLog.firstDecisionById.get(existing.id)?.decision,
          decisionLog.writtenIds.has(existing.id),
        ),
        outcome: "existing",
      };
    }

    await appendMemorySuggestion(workspaceRoot, derived);
    return {
      suggestion: { ...derived, sourceLine: suggestions.length + 1 },
      state: "proposed",
      outcome: "created",
    };
  });
}

async function deriveSuggestion(
  workspaceRoot: string,
  sessionId: string,
  now: () => Date,
): Promise<VersionedMemorySuggestion> {
  const explanation = await explainSession(workspaceRoot, sessionId);
  if (!explanation.audit)
    throw new Error(`Session does not contain actionable audit evidence: ${sessionId}`);

  const successfulCommands = explanation.audit.verificationCommands
    .filter((command) => command.exitCode === 0 && !command.timedOut)
    .map((command) => command.command);
  const changedFiles = explanation.audit.changeGroups.forgeletChanged;
  if (changedFiles.length === 0 && successfulCommands.length === 0)
    throw new Error(`Session did not produce a high-confidence memory suggestion: ${sessionId}`);

  const text = formatActionableAuditMemory(changedFiles, successfulCommands);
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const traceBytes = await readFile(tracePath);
  const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
  const started = events.find((event) => event.type === "session_started");
  const finished = events.find((event) => event.type === "session_finished");
  const startedAt = typeof started?.payload.startedAt === "string"
    ? started.payload.startedAt
    : started?.ts;
  const finishedAt = typeof finished?.payload.finishedAt === "string"
    ? finished.payload.finishedAt
    : finished?.ts;
  if (!startedAt || !finishedAt) {
    throw new Error(
      `Session does not contain complete timing evidence for Memory Suggestion provenance: ${sessionId}`,
    );
  }

  const provenance: MemorySuggestionProvenance = {
    derivation: {
      changedFiles: boundEvidence(changedFiles, PROVENANCE_ITEM_LIMIT),
      successfulVerificationCommands: boundEvidence(
        successfulCommands,
        PROVENANCE_COMMAND_LIMIT,
      ),
    },
    trace: {
      path: relative(workspaceRoot, tracePath).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(traceBytes).digest("hex"),
      bytes: traceBytes.byteLength,
    },
    session: {
      workflow: explanation.workflow,
      status: explanation.status,
      startedAt,
      finishedAt,
    },
  };

  return {
    schemaVersion: 1,
    id: `mem_${createHash("sha256")
      .update(`${sessionId}\n${text}`)
      .digest("hex")
      .slice(0, 12)}`,
    sourceSessionId: sessionId,
    text,
    createdAt: now().toISOString(),
    provenance,
  };
}

function formatActionableAuditMemory(
  changedFiles: string[],
  successfulCommands: string[],
): string {
  const fileText = changedFiles.length > 0
    ? `after changing ${changedFiles.join(", ")}`
    : "after an actionable coding Session";
  const commandText = successfulCommands.length > 0
    ? `, use ${successfulCommands.join(", ")} as verification.`
    : ".";
  return `In this workspace, ${fileText}${commandText}`;
}

async function appendMemorySuggestion(
  workspaceRoot: string,
  suggestion: VersionedMemorySuggestion,
): Promise<void> {
  const forgeletDir = join(workspaceRoot, ".forgelet");
  await mkdir(forgeletDir, { recursive: true });
  await appendFile(
    join(forgeletDir, MEMORY_SUGGESTIONS_FILE),
    `${JSON.stringify(suggestion)}\n`,
    "utf8",
  );
}

function boundEvidence(items: string[], limit: number): BoundedMemoryEvidence {
  return {
    items: items.slice(0, limit).map(truncateProvenanceString),
    total: items.length,
  };
}

function truncateProvenanceString(value: string): string {
  return value.length > PROVENANCE_STRING_LIMIT
    ? `${value.slice(0, PROVENANCE_STRING_LIMIT - 3)}...`
    : value;
}

function resolveMemoryFile(workspaceRoot: string, memoryFile: string): string {
  return isAbsolute(memoryFile) ? memoryFile : join(workspaceRoot, memoryFile);
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
