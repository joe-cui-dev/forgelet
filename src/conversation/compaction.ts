import type { ModelMessage } from "../types.js";

export interface CompactionOptions {
  maxConversationBytes: number;
  observationDigestPreviewBytes?: number;
}

export interface CompactionResult {
  compactedCount: number;
  uncompactableCount: number;
  beforeConversationBytes: number;
  afterConversationBytes: number;
  targetConversationBytes: number;
  toolNames: string[];
  residualOverageBytes: number;
}

export interface ParsedObservation {
  ok: boolean;
  toolCallId: string;
  toolName: string;
  summary: string;
  content?: string;
  digest?: string;
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
  const beforeConversationBytes = conversationBytes(conversation);
  const result: CompactionResult = {
    compactedCount: 0,
    uncompactableCount: 0,
    beforeConversationBytes,
    afterConversationBytes: beforeConversationBytes,
    targetConversationBytes: options.maxConversationBytes,
    toolNames: [],
    residualOverageBytes: Math.max(
      0,
      beforeConversationBytes - options.maxConversationBytes,
    ),
  };
  if (beforeConversationBytes <= options.maxConversationBytes) return result;

  const toolMessages = conversation
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "tool");
  const newestTurnStart = newestToolTurnStart(conversation);
  const oldCandidates = toolMessages.filter(
    ({ index }) => index < newestTurnStart,
  );
  const candidates = [
    ...oldCandidates.filter(({ message }) => hasPriorityToolName(message)),
    ...oldCandidates.filter(({ message }) => !hasPriorityToolName(message)),
  ];
  const compactedTools = new Set<string>();

  for (const candidate of candidates) {
    if (conversationBytes(conversation) <= options.maxConversationBytes) break;
    const parsed = parseObservation(candidate.message.content);
    if (!parsed) {
      result.uncompactableCount += 1;
      continue;
    }
    if (parsed.compacted === true) continue;
    candidate.message.content = JSON.stringify(
      compactObservation(parsed, options),
    );
    result.compactedCount += 1;
    compactedTools.add(parsed.toolName);
  }

  result.afterConversationBytes = conversationBytes(conversation);
  result.toolNames = [...compactedTools];
  result.residualOverageBytes = Math.max(
    0,
    result.afterConversationBytes - options.maxConversationBytes,
  );
  return result;
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

export function parseObservation(
  content: string,
): ParsedObservation | undefined {
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

function compactObservation(
  observation: ParsedObservation,
  options: CompactionOptions,
): ParsedObservation {
  return {
    ok: observation.ok,
    toolCallId: observation.toolCallId,
    toolName: observation.toolName,
    summary: observation.summary,
    digest: digestObservation(observation),
    compacted: true,
    error: compactError(observation.error),
    metadata: compactMetadata(observation, options),
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
  observation: ParsedObservation,
  options: CompactionOptions,
): Record<string, unknown> {
  const metadata = observation.metadata;
  if (!metadata) return {};
  const compact: Record<string, unknown> = {};
  for (const key of COMPACT_METADATA_KEYS) {
    if (metadata[key] !== undefined) compact[key] = metadata[key];
  }
  const previewSource =
    typeof observation.content === "string"
      ? observation.content
      : typeof metadata.preview === "string"
        ? metadata.preview
        : undefined;
  if (previewSource)
    compact.preview = clipUtf8(
      previewSource,
      options.observationDigestPreviewBytes ?? 2_048,
    );
  return compact;
}

function digestObservation(observation: ParsedObservation): string {
  const metadata = observation.metadata ?? {};
  const subject =
    typeof metadata.path === "string" && metadata.path
      ? metadata.path
      : observation.toolName;
  const range = digestRange(metadata);
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
    `${range}, ${state}${continuation}.`,
  ].join("");
}

function digestRange(metadata: Record<string, unknown>): string {
  if (
    typeof metadata.returnedStartByte === "number" &&
    typeof metadata.returnedEndByte === "number"
  ) {
    const total =
      typeof metadata.totalBytes === "number"
        ? ` of ${metadata.totalBytes}`
        : "";
    return `, byte range ${metadata.returnedStartByte}-${metadata.returnedEndByte}${total}`;
  }
  if (
    typeof metadata.returnedStartLine === "number" &&
    typeof metadata.returnedEndLine === "number"
  )
    return `, line range ${metadata.returnedStartLine}-${metadata.returnedEndLine}`;
  return "";
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

function conversationBytes(conversation: ModelMessage[]): number {
  return conversation.reduce(
    (total, message) =>
      total +
      (message.role === "assistant" || message.role === "tool"
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
