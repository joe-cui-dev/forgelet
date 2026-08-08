import { createHash } from "node:crypto";
import { access, appendFile, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig } from "../config/index.js";
import { foldSessionTrace } from "../sessions/index.js";
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
import type { ModelClient } from "../types.js";
import {
  RETROSPECTIVE_ANCHOR_FILES,
  runRetrospectiveSession,
} from "../workflows/retrospective.js";
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

export interface SuggestMemoryOptions {
  now?: () => Date;
  /** The model client that runs the Retrospective Session. Required only when
   * the Session carries a Friction Signal; a gate miss never touches it. */
  modelClient?: ModelClient;
  homeDir?: string;
  debug?: boolean;
  budgetUsd?: number;
  signal?: AbortSignal;
}

export interface SuggestedMemory {
  suggestion: SuggestionRecord;
  state: MemoryReviewState;
  outcome: "created" | "existing";
}

export interface SuggestMemoryResult {
  sourceSessionId: string;
  /** Whether the source Session passed the Friction Signal gate (ADR 0075). A
   * Session that did not is never examined and yields no suggestions. */
  admitted: boolean;
  /** The Retrospective Session that examined the source Session, when one ran. */
  derivationSessionId?: string;
  suggestions: SuggestedMemory[];
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

/** Derives 0..N immutable schema-v1 proposals for one finished Session by
 * running a Retrospective Session gated on Friction (ADR 0075), then appends
 * the new ones. A Session carrying no Friction Signal is never examined and
 * yields nothing instead of throwing. All appends happen under the shared
 * memory lock so Compatibility Import and decision evidence cannot race
 * proposal deduplication. */
export async function suggestMemoryFromSession(
  workspaceRoot: string,
  sessionId: string,
  options: SuggestMemoryOptions = {},
): Promise<SuggestMemoryResult> {
  const now = options.now ?? (() => new Date());
  const derived = await deriveSuggestions(workspaceRoot, sessionId, now, options);
  if (!derived.admitted)
    return { sourceSessionId: sessionId, admitted: false, suggestions: [] };

  // Deduplicate the model's own output first: two identical bullets share one
  // canonical id, so they must not append twice.
  const uniqueDerived = dedupeByText(derived.records);

  const suggestions = await withMemoryDecisionLock(workspaceRoot, async () => {
    await readSuggestionRecords(workspaceRoot);
    await readDecisionLogRecords(workspaceRoot);
    await runCompatibilityImportLocked(workspaceRoot, { now });
    const persisted = await readSuggestionRecords(workspaceRoot);
    const decisionLog = foldDecisionLog(await readDecisionLogRecords(workspaceRoot));

    const results: SuggestedMemory[] = [];
    let appendedLine = persisted.length;
    for (const record of uniqueDerived) {
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

  return {
    sourceSessionId: sessionId,
    admitted: true,
    ...(derived.derivationSessionId ? { derivationSessionId: derived.derivationSessionId } : {}),
    suggestions,
  };
}

interface DerivedSuggestions {
  admitted: boolean;
  derivationSessionId?: string;
  records: VersionedMemorySuggestion[];
}

async function deriveSuggestions(
  workspaceRoot: string,
  sessionId: string,
  now: () => Date,
  options: SuggestMemoryOptions,
): Promise<DerivedSuggestions> {
  const tracePath = await findSessionTracePath(workspaceRoot, sessionId);
  const traceBytes = await readFile(tracePath);
  const events = (await readTraceFile(tracePath)).filter(isTraceEvent);
  const lifecycle = foldSessionTrace(events);
  if (!lifecycle)
    throw new Error(`Session trace does not contain session_started: ${sessionId}`);

  const gate = detectFrictionSignals(events);
  if (!gate.admitted) return { admitted: false, records: [] };

  if (!options.modelClient)
    throw new Error(
      `A model client is required to derive Memory Suggestions from a Session carrying a Friction Signal: ${sessionId}`,
    );

  const startedAt = lifecycle.startedAt;
  // A Session that hit Friction but never recorded `session_finished` is still
  // examined (the gate is friction, not completion); its provenance ends at the
  // last recorded Trace event rather than a finish it never reached.
  const finishedAt = lifecycle.finishedAt ?? events.at(-1)?.ts ?? startedAt;
  if (!startedAt || !finishedAt)
    throw new Error(
      `Session does not contain start-time evidence for Memory Suggestion provenance: ${sessionId}`,
    );

  const retrospective = await runRetrospectiveSession({
    workspaceRoot,
    modelClient: options.modelClient,
    sourceSessionId: sessionId,
    sourceTraceContent: traceBytes.toString("utf8"),
    frictionSignals: gate.signals,
    anchorFiles: await existingAnchorFiles(workspaceRoot),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
    ...(options.debug ? { debug: options.debug } : {}),
    ...(options.budgetUsd !== undefined ? { budgetUsd: options.budgetUsd } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const derivationSessionId = retrospective.session.id;
  const suggestions = retrospective.completion?.suggestions ?? [];

  const provenance: MemorySuggestionProvenance = {
    derivation: { frictionSignals: boundFrictionSignals(gate.signals) },
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
    derivationSessionId,
  };

  const createdAt = now().toISOString();
  const records = suggestions.map((text) => ({
    schemaVersion: 1 as const,
    id: `mem_${createHash("sha256")
      .update(`${sessionId}\n${text}`)
      .digest("hex")
      .slice(0, 12)}`,
    sourceSessionId: sessionId,
    text,
    createdAt,
    provenance,
  }));

  return { admitted: true, derivationSessionId, records };
}

function dedupeByText(
  records: VersionedMemorySuggestion[],
): VersionedMemorySuggestion[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.text)) return false;
    seen.add(record.text);
    return true;
  });
}

/** The Anchor Files a Retrospective Session should compare against, filtered to
 * the ones this workspace actually has so a missing file never fails a
 * derivation launch. */
async function existingAnchorFiles(workspaceRoot: string): Promise<string[]> {
  const present: string[] = [];
  for (const file of RETROSPECTIVE_ANCHOR_FILES) {
    try {
      await access(join(workspaceRoot, file));
      present.push(file);
    } catch {
      // A workspace without this Anchor File simply omits it from the comparison.
    }
  }
  return present;
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
