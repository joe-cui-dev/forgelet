import type { ToolResult } from "../types.js";

const TRACE_PREVIEW_CHARS = 500;

export type ToolObservationErrorCode =
  | "unknown_tool"
  | "permission_denied"
  | "invalid_input"
  | "tool_failed"
  | "web_egress_denied"
  | "web_fetch_failed"
  | "web_content_rejected"
  | "web_budget_exhausted"
  | "web_search_failed";

export const OBSERVATION_METADATA_FIELDS = {
  truncated: { kind: "boolean", digestKept: true },
  totalBytes: { kind: "number", digestKept: true },
  returnedBytes: { kind: "number", digestKept: true },
  contentHash: { kind: "string", digestKept: true },
  path: { kind: "string", digestKept: true },
  rangeKind: { kind: "string", digestKept: true },
  offsetBytes: { kind: "number", digestKept: true },
  limitBytes: { kind: "number", digestKept: true },
  startLine: { kind: "number", digestKept: true },
  lineCount: { kind: "number", digestKept: true },
  tailLines: { kind: "number", digestKept: true },
  returnedStartByte: { kind: "number", digestKept: true },
  returnedEndByte: { kind: "number", digestKept: true },
  returnedStartLine: { kind: "number", digestKept: true },
  returnedEndLine: { kind: "number", digestKept: true },
  nextOffsetBytes: { kind: "number", digestKept: true },
  changedFiles: { kind: "string[]", digestKept: true },
  command: { kind: "string", digestKept: true },
  exitCode: { kind: "number-or-null", digestKept: true },
  durationMs: { kind: "number", digestKept: true },
  timedOut: { kind: "boolean", digestKept: true },
  scopeConstrained: { kind: "boolean", digestKept: true },
  url: { kind: "string", digestKept: false },
  finalUrl: { kind: "string", digestKept: false },
  httpStatus: { kind: "number", digestKept: false },
  fetchedBytes: { kind: "number", digestKept: false },
  storedBytes: { kind: "number", digestKept: false },
  contentType: { kind: "string", digestKept: false },
  sourceId: { kind: "string", digestKept: false },
  deduplicated: { kind: "boolean", digestKept: false },
  requestedCount: { kind: "number", digestKept: false },
  returnedCount: { kind: "number", digestKept: false },
} as const;

type ObservationMetadataKind =
  (typeof OBSERVATION_METADATA_FIELDS)[keyof typeof OBSERVATION_METADATA_FIELDS]["kind"];

type ObservationMetadataValue<Kind extends ObservationMetadataKind> =
  Kind extends "number"
    ? number
    : Kind extends "string"
      ? string
      : Kind extends "boolean"
        ? boolean
        : Kind extends "string[]"
          ? string[]
          : Kind extends "number-or-null"
            ? number | null
            : never;

export type ObservationMetadata = {
  [Key in keyof typeof OBSERVATION_METADATA_FIELDS]?: ObservationMetadataValue<
    (typeof OBSERVATION_METADATA_FIELDS)[Key]["kind"]
  >;
} & { preview?: string };

export interface ToolObservation {
  ok: boolean;
  toolCallId: string;
  toolName: string;
  summary: string;
  content?: string;
  error?: { code: ToolObservationErrorCode; message: string };
  metadata: ObservationMetadata;
}

export interface ParsedObservation {
  ok: boolean;
  toolCallId: string;
  toolName: string;
  summary: string;
  content?: string;
  digest?: string;
  compacted?: boolean;
  error?: { code?: unknown; message?: unknown };
  metadata?: Record<string, unknown>;
}

export interface ObservationRange {
  kind: "byte" | "line";
  start: number;
  end: number;
  total?: number;
}

export const toolResultToObservation = (
  result: ToolResult,
  toolCallId: string,
  toolName: string,
): ToolObservation => {
  const data = isRecord(result.data) ? result.data : {};
  const content = typeof data.content === "string" ? data.content : undefined;
  const metadata: ObservationMetadata = {};
  for (const [key, field] of Object.entries(OBSERVATION_METADATA_FIELDS)) {
    const value = data[key];
    if (field.kind === "string[]" && Array.isArray(value)) {
      (metadata as Record<string, unknown>)[key] = value.filter(
        (item): item is string => typeof item === "string",
      );
      continue;
    }
    if (matchesMetadataKind(value, field.kind))
      (metadata as Record<string, unknown>)[key] = value;
  }
  if (content) metadata.preview = content.slice(0, TRACE_PREVIEW_CHARS);
  return {
    ok: result.ok,
    toolCallId,
    toolName,
    summary: result.summary,
    content,
    error: result.ok
      ? undefined
      : {
          code: result.errorCode ?? "tool_failed",
          message: result.error ?? result.summary,
        },
    metadata,
  };
};

export const deniedToolObservation = (
  toolCallId: string,
  toolName: string,
  message: string,
): ToolObservation => ({
  ok: false,
  toolCallId,
  toolName,
  summary: message,
  error: { code: "permission_denied", message },
  metadata: {},
});

export const unknownToolObservation = (
  toolCallId: string,
  toolName: string,
): ToolObservation => {
  const message = `Unknown tool: ${toolName}`;
  return {
    ok: false,
    toolCallId,
    toolName,
    summary: message,
    error: { code: "unknown_tool", message },
    metadata: {},
  };
};

export const observationForModel = (
  observation: ToolObservation,
): Record<string, unknown> => ({
  ok: observation.ok,
  toolCallId: observation.toolCallId,
  toolName: observation.toolName,
  summary: observation.summary,
  content: observation.content,
  error: observation.error,
  metadata: observation.metadata,
});

export function parseObservation(content: string): ParsedObservation | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    if (
      !isRecord(value) ||
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

export function toObservationDigest(
  observation: ParsedObservation,
  previewBytes: number,
): { digest: string; metadata: Record<string, unknown> } {
  const metadata = observation.metadata ?? {};
  const compact: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(OBSERVATION_METADATA_FIELDS))
    if (field.digestKept && metadata[key] !== undefined) compact[key] = metadata[key];
  const previewSource =
    typeof observation.content === "string"
      ? observation.content
      : typeof metadata.preview === "string"
        ? metadata.preview
        : undefined;
  if (previewSource) compact.preview = clipUtf8(previewSource, previewBytes);
  return { digest: digestObservation(observation), metadata: compact };
}

export function digestObservation(observation: ParsedObservation): string {
  const metadata = observation.metadata ?? {};
  const subject =
    typeof metadata.path === "string" && metadata.path
      ? metadata.path
      : observation.toolName;
  const range = observationRangeFromMetadata(metadata);
  const state =
    metadata.truncated === true
      ? "truncated"
      : metadata.truncated === false
        ? "complete"
        : "returned";
  const continuation =
    typeof metadata.nextOffsetBytes === "number"
      ? `, next offset ${metadata.nextOffsetBytes}`
      : "";
  return [
    `Compacted ${observation.toolName} result for ${subject}`,
    `${range ? `, ${formatObservationRange(range)}` : ""}, ${state}${continuation}.`,
  ].join("");
}

export function observationRangeFromMetadata(
  metadata: Record<string, unknown>,
): ObservationRange | undefined {
  if (
    typeof metadata.returnedStartByte === "number" &&
    typeof metadata.returnedEndByte === "number"
  )
    return {
      kind: "byte",
      start: metadata.returnedStartByte,
      end: metadata.returnedEndByte,
      ...(typeof metadata.totalBytes === "number" ? { total: metadata.totalBytes } : {}),
    };
  if (
    typeof metadata.returnedStartLine === "number" &&
    typeof metadata.returnedEndLine === "number"
  )
    return {
      kind: "line",
      start: metadata.returnedStartLine,
      end: metadata.returnedEndLine,
    };
  return undefined;
}

export function formatObservationRange(range: ObservationRange): string {
  return `${range.kind} range ${range.start}-${range.end}${
    range.kind === "byte" && range.total !== undefined ? ` of ${range.total}` : ""
  }`;
}

export function mergeObservationRanges(
  ranges: ObservationRange[],
): ObservationRange[] {
  const sorted = [...ranges].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.start - right.start ||
      left.end - right.end,
  );
  const merged: ObservationRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.kind === range.kind &&
      previous.total === range.total &&
      range.start <= previous.end + 1
    )
      previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function matchesMetadataKind(
  value: unknown,
  kind: ObservationMetadataKind,
): boolean {
  if (kind === "string[]") return Array.isArray(value) && value.every((item) => typeof item === "string");
  if (kind === "number-or-null") return typeof value === "number" || value === null;
  return typeof value === kind;
}

function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let text = "";
  for (const char of value) {
    if (Buffer.byteLength(text + char, "utf8") > maxBytes) break;
    text += char;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
