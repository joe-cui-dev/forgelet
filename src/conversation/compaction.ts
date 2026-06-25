import type { ModelMessage } from "../types.js";

export interface CompactionOptions {
  maxObservationBytes: number;
}

export interface CompactionResult {
  compactedCount: number;
  uncompactableCount: number;
  beforeObservationBytes: number;
  afterObservationBytes: number;
  targetObservationBytes: number;
  toolNames: string[];
  residualOverageBytes: number;
}

interface ParsedObservation {
  ok: boolean;
  toolCallId: string;
  toolName: string;
  summary: string;
  content?: string;
  compacted?: boolean;
  error?: {
    code?: unknown;
    message?: unknown;
  };
  metadata?: Record<string, unknown>;
}

const PRIORITY_TOOL_NAMES = new Set(["read_file", "git_diff", "run_command"]);

export function compactConversationInPlace(
  conversation: ModelMessage[],
  options: CompactionOptions,
): CompactionResult {
  const beforeObservationBytes = observationBytes(conversation);
  const result: CompactionResult = {
    compactedCount: 0,
    uncompactableCount: 0,
    beforeObservationBytes,
    afterObservationBytes: beforeObservationBytes,
    targetObservationBytes: options.maxObservationBytes,
    toolNames: [],
    residualOverageBytes: Math.max(
      0,
      beforeObservationBytes - options.maxObservationBytes,
    ),
  };
  if (beforeObservationBytes <= options.maxObservationBytes) return result;

  const toolMessages = conversation
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool");
  const newestTurnStart = newestToolTurnStart(conversation);
  const oldCandidates = toolMessages.filter(
    ({ index }) => index < newestTurnStart,
  );
  const newestCandidates = toolMessages.filter(
    ({ index }) => index > newestTurnStart,
  );
  const protectedIndexes = protectedNewestObservationIndexes(newestCandidates);
  const candidates = [
    ...oldCandidates.filter(({ message }) => hasPriorityToolName(message)),
    ...oldCandidates.filter(({ message }) => !hasPriorityToolName(message)),
    ...newestCandidates.filter(
      ({ message, index }) =>
        !protectedIndexes.has(index) && hasPriorityToolName(message),
    ),
    ...newestCandidates.filter(
      ({ message, index }) =>
        !protectedIndexes.has(index) && !hasPriorityToolName(message),
    ),
  ];
  const compactedTools = new Set<string>();

  for (const candidate of candidates) {
    if (observationBytes(conversation) <= options.maxObservationBytes) break;
    const parsed = parseObservation(candidate.message.content);
    if (!parsed) {
      result.uncompactableCount += 1;
      continue;
    }
    if (parsed.compacted === true) continue;
    candidate.message.content = JSON.stringify(compactObservation(parsed));
    result.compactedCount += 1;
    compactedTools.add(parsed.toolName);
  }

  result.afterObservationBytes = observationBytes(conversation);
  result.toolNames = [...compactedTools];
  result.residualOverageBytes = Math.max(
    0,
    result.afterObservationBytes - options.maxObservationBytes,
  );
  return result;
}

function protectedNewestObservationIndexes(
  newestCandidates: Array<{ message: ModelMessage; index: number }>,
): Set<number> {
  const protectedIndexes = new Set<number>();
  const newest = newestCandidates.at(-1);
  if (newest) protectedIndexes.add(newest.index);
  for (let index = newestCandidates.length - 1; index >= 0; index -= 1) {
    const candidate = newestCandidates[index];
    if (!candidate) continue;
    const parsed = parseObservation(candidate.message.content);
    if (parsed?.ok !== false) continue;
    protectedIndexes.add(candidate.index);
    break;
  }
  return protectedIndexes;
}

function newestToolTurnStart(conversation: ModelMessage[]): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    if (message?.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
      return index;
  }
  return conversation.length;
}

function hasPriorityToolName(message: ModelMessage): boolean {
  const parsed = parseObservation(message.content);
  return parsed ? PRIORITY_TOOL_NAMES.has(parsed.toolName) : false;
}

function parseObservation(content: string): ParsedObservation | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    if (!isRecord(value)) return undefined;
    if (
      typeof value.ok !== "boolean" ||
      typeof value.toolCallId !== "string" ||
      typeof value.toolName !== "string" ||
      typeof value.summary !== "string"
    )
      return undefined;
    return value as unknown as ParsedObservation;
  } catch {
    return undefined;
  }
}

function compactObservation(observation: ParsedObservation): ParsedObservation {
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    compacted: true,
    error: compactError(observation.error),
    metadata: compactMetadata(observation.metadata),
  };
}

function compactError(
  error: ParsedObservation["error"],
): ParsedObservation["error"] {
  if (!error) return undefined;
  return {
    code: error.code,
    message: error.message,
  };
}

function compactMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const compact: Record<string, unknown> = {};
  for (const key of COMPACT_METADATA_KEYS) {
    if (metadata[key] !== undefined) compact[key] = metadata[key];
  }
  if (typeof metadata.preview === "string")
    compact.preview = clipUtf8(metadata.preview, 512);
  return compact;
}

const COMPACT_METADATA_KEYS = [
  "path",
  "contentHash",
  "rangeKind",
  "offsetBytes",
  "limitBytes",
  "startLine",
  "lineCount",
  "tailLines",
  "returnedStartByte",
  "returnedEndByte",
  "returnedStartLine",
  "returnedEndLine",
  "returnedBytes",
  "totalBytes",
  "nextOffsetBytes",
  "truncated",
  "changedFiles",
  "command",
  "exitCode",
  "durationMs",
  "timedOut",
  "scopeConstrained",
] as const;

function observationBytes(conversation: ModelMessage[]): number {
  return conversation.reduce(
    (total, message) =>
      total +
      (message.role === "tool"
        ? Buffer.byteLength(message.content, "utf8")
        : 0),
    0,
  );
}

function clipUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
