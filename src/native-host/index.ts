import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { currentBrowserSnapshotPath } from "../browser/index.js";

export type NativeHostMessage =
  | {
      type: "shareCurrentPage";
      payload: {
        url: string;
        title: string;
        capturedAt: string;
        selectedText?: string;
        mainText?: string;
        screenshotPath?: string;
      };
    }
  | Record<string, unknown>;

export type NativeHostResponse =
  | {
      ok: true;
      snapshotPath: string;
      url: string;
      title: string;
      contentKind: "selectedText" | "mainText";
      contentBytes: number;
      contentHash: string;
      capturedAt: string;
    }
  | { ok: false; error: string };

export async function handleNativeHostMessage(
  message: NativeHostMessage,
  input: { homeDir?: string } = {},
): Promise<NativeHostResponse> {
  try {
    if (!isRecord(message) || message.type !== "shareCurrentPage") {
      throw new Error("Unsupported Native Messaging command.");
    }
    const payload = parseShareCurrentPagePayload(message.payload);
    const selectedText = normalizeContent(payload.selectedText);
    const mainText = normalizeContent(payload.mainText);
    const contentKind = selectedText ? "selectedText" : "mainText";
    const content = selectedText || mainText;
    if (!content) {
      throw new Error("Browser snapshot must include selectedText or mainText.");
    }

    const snapshotPath = currentBrowserSnapshotPath(input.homeDir);
    await writeSnapshotAtomically(snapshotPath, {
      url: payload.url,
      title: payload.title,
      capturedAt: payload.capturedAt,
      ...(selectedText ? { selectedText } : {}),
      ...(!selectedText && mainText ? { mainText } : {}),
      ...(payload.screenshotPath ? { screenshotPath: payload.screenshotPath } : {}),
    });

    return {
      ok: true,
      snapshotPath,
      url: payload.url,
      title: payload.title,
      contentKind,
      contentBytes: Buffer.byteLength(content, "utf8"),
      contentHash: createHash("sha256").update(content).digest("hex"),
      capturedAt: payload.capturedAt,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function handleNativeHostBuffer(
  buffer: Buffer,
  input: { homeDir?: string } = {},
): Promise<Buffer> {
  if (buffer.byteLength < 4) {
    return encodeNativeHostResponse({
      ok: false,
      error: "Native Messaging input is missing the message length prefix.",
    });
  }
  const messageLength = buffer.readUInt32LE(0);
  const messageBytes = buffer.subarray(4);
  if (messageBytes.byteLength !== messageLength) {
    return encodeNativeHostResponse({
      ok: false,
      error: "Native Messaging input length does not match the payload.",
    });
  }
  let message: unknown;
  try {
    message = JSON.parse(messageBytes.toString("utf8"));
  } catch {
    return encodeNativeHostResponse({
      ok: false,
      error: "Native Messaging input is not valid JSON.",
    });
  }
  return encodeNativeHostResponse(
    await handleNativeHostMessage(message as NativeHostMessage, input),
  );
}

function encodeNativeHostResponse(response: NativeHostResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(response), "utf8");
  const output = Buffer.alloc(4 + payload.byteLength);
  output.writeUInt32LE(payload.byteLength, 0);
  payload.copy(output, 4);
  return output;
}

async function writeSnapshotAtomically(
  snapshotPath: string,
  snapshot: Record<string, string>,
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true });
  const tempPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tempPath, snapshotPath);
}

function parseShareCurrentPagePayload(value: unknown): {
  url: string;
  title: string;
  capturedAt: string;
  selectedText?: string;
  mainText?: string;
  screenshotPath?: string;
} {
  if (!isRecord(value)) throw new Error("shareCurrentPage payload must be an object.");
  const url = requiredString(value, "url");
  const title = requiredString(value, "title");
  const capturedAt = requiredString(value, "capturedAt");
  return {
    url,
    title,
    capturedAt,
    ...(optionalString(value, "selectedText") !== undefined
      ? { selectedText: optionalString(value, "selectedText") }
      : {}),
    ...(optionalString(value, "mainText") !== undefined
      ? { mainText: optionalString(value, "mainText") }
      : {}),
    ...(optionalString(value, "screenshotPath") !== undefined
      ? { screenshotPath: optionalString(value, "screenshotPath") }
      : {}),
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`shareCurrentPage payload is missing ${key}.`);
  }
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") {
    throw new Error(`shareCurrentPage payload field ${key} must be a string.`);
  }
  return field;
}

function normalizeContent(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function runNativeHostStdio(input: {
  stdin: Readable;
  stdout: Writable;
  homeDir?: string;
}): Promise<void> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let expectedBytes: number | undefined;
  for await (const chunk of input.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    totalBytes += chunks[chunks.length - 1]?.byteLength ?? 0;
    if (expectedBytes === undefined && totalBytes >= 4) {
      expectedBytes = Buffer.concat(chunks, totalBytes).readUInt32LE(0) + 4;
    }
    if (expectedBytes !== undefined && totalBytes >= expectedBytes) break;
  }
  const request = Buffer.concat(chunks, totalBytes);
  const response = await handleNativeHostBuffer(trimToFirstMessage(request), {
    homeDir: input.homeDir,
  });
  input.stdout.write(response);
}

function trimToFirstMessage(buffer: Buffer): Buffer {
  if (buffer.byteLength < 4) return buffer;
  const expectedBytes = buffer.readUInt32LE(0) + 4;
  return buffer.subarray(0, expectedBytes);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runNativeHostStdio({
    stdin: process.stdin,
    stdout: process.stdout,
    homeDir: process.env.HOME,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const payload = Buffer.from(JSON.stringify({ ok: false, error: message }), "utf8");
    const response = Buffer.alloc(4 + payload.byteLength);
    response.writeUInt32LE(payload.byteLength, 0);
    payload.copy(response, 4);
    process.stdout.write(response);
  });
}
