import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig } from "../config/index.js";
import { foldSessionTrace, type SessionTraceFold } from "../sessions/index.js";
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
import { detectFrictionSignals, type FrictionSignal } from "./frictionSignal.js";
import type {
  BoundedFrictionSignals,
  MemorySuggestionProvenance,
  VersionedMemorySuggestion,
} from "./types.js";

const MEMORY_SUGGESTIONS_FILE = "memory-suggestions.jsonl";
const DURABLE_MEMORY_PROMPT_LIMIT_BYTES = 20 * 1024;
const PROVENANCE_FRICTION_LIMIT = 20;
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

/** The Friction Signals a finished Session carried, alongside its folded
 * lifecycle. Read once from the Trace, it gates the Session-end capture prompt
 * (ADR 0076) and gives it the lines to show; the same read backs the provenance
 * a captured entry records. */
export interface SessionFriction {
  signals: FrictionSignal[];
  lifecycle: SessionTraceFold;
}

/** Reads a finished Session's Trace and returns its Friction Signals and folded
 * lifecycle. Throws when the Trace has no `session_started` — there is nothing
 * to attribute a Memory Suggestion to. */
export async function readSessionFriction(
  workspaceRoot: string,
  sessionId: string,
): Promise<SessionFriction> {
  const { lifecycle, signals } = await loadCaptureContext(workspaceRoot, sessionId);
  return { signals, lifecycle };
}

export interface CaptureMemoryOptions {
  now?: () => Date;
}

export interface CapturedMemory {
  suggestion: SuggestionRecord;
  state: MemoryReviewState;
  outcome: "created" | "existing";
}

/** Records one or more human-authored lines as immutable schema-v1 Memory
 * Suggestions for a finished Session (ADR 0076). Provenance is drawn from the
 * Session's closed Trace — its bytes, hash, lifecycle, and Friction Signals —
 * so a captured entry is as traceable as a derived one was. Appends happen
 * under the shared memory lock, and a line already present for this Session is
 * returned as `existing` rather than appended twice. */
export async function captureMemorySuggestions(
  workspaceRoot: string,
  sessionId: string,
  texts: string[],
  options: CaptureMemoryOptions = {},
): Promise<CapturedMemory[]> {
  const cleaned = dedupeText(texts.map((text) => text.trim()).filter((text) => text.length > 0));
  if (cleaned.length === 0) return [];

  const now = options.now ?? (() => new Date());
  const context = await loadCaptureContext(workspaceRoot, sessionId);
  const provenance = buildProvenance(workspaceRoot, context);
  const createdAt = now().toISOString();
  const records: VersionedMemorySuggestion[] = cleaned.map((text) => ({
    schemaVersion: 1 as const,
    id: `mem_${createHash("sha256").update(`${sessionId}\n${text}`).digest("hex").slice(0, 12)}`,
    sourceSessionId: sessionId,
    text,
    createdAt,
    provenance,
  }));

  return withMemoryDecisionLock(workspaceRoot, async () => {
    await runCompatibilityImportLocked(workspaceRoot, { now });
    const persisted = await readSuggestionRecords(workspaceRoot);
    const decisionLog = foldDecisionLog(await readDecisionLogRecords(workspaceRoot));

    const results: CapturedMemory[] = [];
    let appendedLine = persisted.length;
    for (const record of records) {
      const existing = persisted.find(
        (candidate) =>
          candidate.sourceSessionId === record.sourceSessionId &&
          candidate.text === record.text,
      );
      if (existing) {
        results.push({
          suggestion: existing,
          state: deriveMemoryReviewState(
            decisionLog.firstDecisionById.get(existing.id)?.decision,
            decisionLog.writtenIds.has(existing.id),
          ),
          outcome: "existing",
        });
        continue;
      }
      await appendMemorySuggestion(workspaceRoot, record);
      appendedLine += 1;
      persisted.push({ ...record, sourceLine: appendedLine });
      results.push({
        suggestion: { ...record, sourceLine: appendedLine },
        state: "proposed",
        outcome: "created",
      });
    }
    return results;
  });
}

interface CaptureContext {
  tracePath: string;
  traceBytes: Buffer;
  lifecycle: SessionTraceFold;
  signals: FrictionSignal[];
}

async function loadCaptureContext(
  workspaceRoot: string,
  sessionId: string,
): Promise<CaptureContext> {
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const traceBytes = await readFile(tracePath);
  const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
  const lifecycle = foldSessionTrace(events);
  if (!lifecycle)
    throw new Error(`Session trace does not contain session_started: ${sessionId}`);
  const signals = detectFrictionSignals(events).signals;
  return { tracePath, traceBytes, lifecycle, signals };
}

function buildProvenance(
  workspaceRoot: string,
  { tracePath, traceBytes, lifecycle, signals }: CaptureContext,
): MemorySuggestionProvenance {
  const startedAt = lifecycle.startedAt;
  const finishedAt = lifecycle.finishedAt ?? startedAt;
  return {
    derivation: signals.length > 0 ? { frictionSignals: boundFrictionSignals(signals) } : {},
    trace: {
      path: relative(workspaceRoot, tracePath).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(traceBytes).digest("hex"),
      bytes: traceBytes.byteLength,
    },
    session: {
      workflow: lifecycle.workflow,
      status: lifecycle.status,
      startedAt,
      finishedAt,
    },
  };
}

function dedupeText(texts: string[]): string[] {
  const seen = new Set<string>();
  return texts.filter((text) => {
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

function boundFrictionSignals(signals: FrictionSignal[]): BoundedFrictionSignals {
  return {
    items: signals.slice(0, PROVENANCE_FRICTION_LIMIT).map(truncateFrictionSignal),
    total: signals.length,
  };
}

/** Bounds the free-text fields of a Friction Signal so provenance stays a
 * fixed-size evidence record, mirroring the string cap on legacy evidence. */
function truncateFrictionSignal(signal: FrictionSignal): FrictionSignal {
  if (signal.kind === "tool_failure") {
    return {
      ...signal,
      ...(signal.path ? { path: truncateProvenanceString(signal.path) } : {}),
      ...(signal.error ? { error: truncateProvenanceString(signal.error) } : {}),
    };
  }
  return {
    ...signal,
    ...(signal.reason ? { reason: truncateProvenanceString(signal.reason) } : {}),
  };
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
