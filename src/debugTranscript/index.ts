import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface DebugTranscriptEvent {
  type: string;
  ts: string;
  sessionId: string;
  payload: Record<string, unknown>;
}

export interface DebugTranscriptWriter {
  readonly path: string;
  append(event: DebugTranscriptEvent): Promise<void>;
}

export interface DebugTranscriptSummary {
  contentHash: string;
  contentBytes: number;
}

export function debugTranscriptPath(
  workspaceRoot: string,
  sessionId: string,
): string {
  return join(workspaceRoot, ".forgelet", "debug", `${sessionId}.jsonl`);
}

export async function createDebugTranscriptWriter(
  workspaceRoot: string,
  sessionId: string,
): Promise<DebugTranscriptWriter> {
  const path = debugTranscriptPath(workspaceRoot, sessionId);
  await mkdir(join(workspaceRoot, ".forgelet", "debug"), { recursive: true });
  return {
    path,
    async append(event: DebugTranscriptEvent): Promise<void> {
      await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
    },
  };
}

export async function readDebugTranscript(
  workspaceRoot: string,
  sessionId: string,
): Promise<DebugTranscriptEvent[]> {
  return readDebugTranscriptFile(debugTranscriptPath(workspaceRoot, sessionId));
}

export async function readDebugTranscriptFile(
  path: string,
): Promise<DebugTranscriptEvent[]> {
  const content = await readFile(path, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DebugTranscriptEvent);
}

export async function summarizeDebugTranscriptFile(
  path: string,
): Promise<DebugTranscriptSummary> {
  const content = await readFile(path);
  return {
    contentHash: createHash("sha256").update(content).digest("hex"),
    contentBytes: content.byteLength,
  };
}

export async function formatDebugTranscriptShow(input: {
  workspaceRoot: string;
  sessionId: string;
  full: boolean;
}): Promise<string> {
  const path = debugTranscriptPath(input.workspaceRoot, input.sessionId);
  let events: DebugTranscriptEvent[];
  try {
    events = await readDebugTranscriptFile(path);
  } catch (error) {
    const errorRecord = isRecord(error) ? error : {};
    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof errorRecord.message === "string"
          ? errorRecord.message
          : String(error);
    const isMissing =
      errorRecord.code === "ENOENT" || errorMessage.includes("ENOENT");
    if (isMissing)
      throw new Error(
        [
          `Debug Transcript not found for Session: ${input.sessionId}`,
          `Expected: ${relative(input.workspaceRoot, path)}`,
        ].join("\n"),
      );
    throw error;
  }

  return [
    "Debug Transcript",
    `Session: ${input.sessionId}`,
    `Path: ${relative(input.workspaceRoot, path)}`,
    `Events: ${events.length}`,
    "",
    ...events.flatMap((event) => formatDebugTranscriptEvent(event, input.full)),
  ].join("\n").trimEnd();
}

function formatDebugTranscriptEvent(
  event: DebugTranscriptEvent,
  full: boolean,
): string[] {
  const payload = event.payload;
  const turnIndex = typeof payload.turnIndex === "number" ? payload.turnIndex : undefined;
  const prefix = turnIndex === undefined ? [] : [`Turn ${turnIndex + 1}`];
  if (event.type === "model_request") {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    return [
      ...prefix,
      `Model request: ${messages.length} messages, ${tools.length} tools`,
      ...formatMessages(messages, full),
      `Tools: ${tools.map((tool) => recordString(tool, "name")).filter(Boolean).join(", ") || "none"}`,
      "",
    ];
  }
  if (event.type === "model_response") {
    const toolCalls = Array.isArray(payload.toolCalls) ? payload.toolCalls : [];
    return [
      ...prefix,
      `Model response: ${payload.finishReason ?? "unknown"}, ${toolCalls.length} tool calls`,
      `Content: ${previewText(recordString(payload, "content"), full)}`,
      "",
    ];
  }
  if (event.type === "tool_request") {
    const toolCall = isRecord(payload.toolCall) ? payload.toolCall : {};
    return [
      ...prefix,
      `Tool request: ${recordString(toolCall, "name") || "unknown"}`,
      full ? `Input: ${JSON.stringify(toolCall.input ?? {}, null, 2)}` : "",
      "",
    ].filter((line) => line !== "");
  }
  if (event.type === "tool_result") {
    const observation = isRecord(payload.observation) ? payload.observation : {};
    const ok = observation.ok === true ? "ok" : "failed";
    return [
      ...prefix,
      `Tool result: ${recordString(payload, "toolName") || "unknown"} ${ok}`,
      `Summary: ${recordString(observation, "summary")}`,
      `Observation: ${previewText(recordString(observation, "content"), full)}`,
      "",
    ];
  }
  if (event.type === "model_error") {
    const error = isRecord(payload.error) ? payload.error : {};
    return [
      ...prefix,
      `Model error: ${recordString(error, "message")}`,
      "",
    ];
  }
  if (event.type === "session_debug_finished") {
    return [`Debug finished: ${payload.status ?? "unknown"}`, ""];
  }
  return [`${event.type}: ${JSON.stringify(payload)}`, ""];
}

function formatMessages(messages: unknown[], full: boolean): string[] {
  if (messages.length === 0) return ["Messages: none"];
  return [
    "Messages:",
    ...messages.map((message) => {
      const record = isRecord(message) ? message : {};
      return `- ${recordString(record, "role") || "unknown"}: ${previewText(recordString(record, "content"), full)}`;
    }),
  ];
}

function previewText(value: string, full: boolean): string {
  if (full || value.length <= 240) return value;
  return `${value.slice(0, 240)}...`;
}

function recordString(record: unknown, key: string): string {
  if (!isRecord(record)) return "";
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
