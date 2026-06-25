import type { ToolObservation, ToolResult } from "../types.js";

const TRACE_PREVIEW_CHARS = 500;

// Converts tool results into model-visible observations while keeping trace metadata compact.
export const toolResultToObservation = (
  result: ToolResult,
  toolCallId: string,
  toolName: string,
): ToolObservation => {
  const data = isRecord(result.data) ? result.data : {};
  const content = typeof data.content === "string" ? data.content : undefined;
  const metadata: ToolObservation["metadata"] = {};
  if (typeof data.truncated === "boolean") metadata.truncated = data.truncated;
  if (typeof data.totalBytes === "number") metadata.totalBytes = data.totalBytes;
  if (typeof data.returnedBytes === "number")
    metadata.returnedBytes = data.returnedBytes;
  if (typeof data.contentHash === "string")
    metadata.contentHash = data.contentHash;
  if (typeof data.path === "string") metadata.path = data.path;
  if (typeof data.rangeKind === "string") metadata.rangeKind = data.rangeKind;
  copyNumberMetadata(data, metadata, "offsetBytes");
  copyNumberMetadata(data, metadata, "limitBytes");
  copyNumberMetadata(data, metadata, "startLine");
  copyNumberMetadata(data, metadata, "lineCount");
  copyNumberMetadata(data, metadata, "tailLines");
  copyNumberMetadata(data, metadata, "returnedStartByte");
  copyNumberMetadata(data, metadata, "returnedEndByte");
  copyNumberMetadata(data, metadata, "returnedStartLine");
  copyNumberMetadata(data, metadata, "returnedEndLine");
  copyNumberMetadata(data, metadata, "nextOffsetBytes");
  if (Array.isArray(data.changedFiles))
    metadata.changedFiles = data.changedFiles.filter(
      (item): item is string => typeof item === "string",
    );
  if (typeof data.command === "string") metadata.command = data.command;
  if (typeof data.exitCode === "number" || data.exitCode === null)
    metadata.exitCode = data.exitCode;
  if (typeof data.durationMs === "number") metadata.durationMs = data.durationMs;
  if (typeof data.timedOut === "boolean") metadata.timedOut = data.timedOut;
  if (typeof data.scopeConstrained === "boolean")
    metadata.scopeConstrained = data.scopeConstrained;
  if (content) metadata.preview = content.slice(0, TRACE_PREVIEW_CHARS);
  return {
    ok: result.ok,
    toolCallId,
    toolName,
    summary: result.summary,
    content,
    error: result.ok
      ? undefined
      : { code: "tool_failed", message: result.error ?? result.summary },
    metadata,
  };
};

// Produces the standard observation shape for policy-denied tool calls.
export const deniedToolObservation = (
  toolCallId: string,
  toolName: string,
  message: string,
): ToolObservation => {
  return {
    ok: false,
    toolCallId,
    toolName,
    summary: message,
    error: { code: "permission_denied", message },
    metadata: {},
  };
};

// Produces the standard observation shape for model-requested tools that do not exist.
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const copyNumberMetadata = (
  data: Record<string, unknown>,
  metadata: ToolObservation["metadata"],
  key: NumberMetadataKey,
): void => {
  if (typeof data[key] === "number") metadata[key] = data[key];
};

type NumberMetadataKey =
  | "offsetBytes"
  | "limitBytes"
  | "startLine"
  | "lineCount"
  | "tailLines"
  | "returnedStartByte"
  | "returnedEndByte"
  | "returnedStartLine"
  | "returnedEndLine"
  | "nextOffsetBytes";
