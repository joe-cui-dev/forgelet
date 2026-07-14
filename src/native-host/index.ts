import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { currentBrowserSnapshotPath } from "../browser/index.js";
import {
  listWorkspaceProfiles,
  resolveWorkspaceProfile,
  toExtensionWorkspaceProfileProjection,
} from "../browser/workspaceProfiles.js";
import {
  BrowserProtocolValidationError,
  runBrowserInvocation,
  validateBrowserInvocationRequest,
  type BrowserInvocationRequest,
} from "../browser/protocol.js";
import { createBrowserWorkbench } from "../browserWorkbench/index.js";
import { createDeferredLiveModelClient, createDeepSeekLiveModelClient } from "../cli/wiring.js";
import { createBrowserLearningLauncher } from "../sessionLauncher/index.js";
import type { ModelClient } from "../types.js";

const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

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

/** Raw Native Messaging framing only. Browser Workbench owns its application
 * protocol separately, so the host can carry more than the legacy snapshot
 * command without conflating a protocol frame with stdio bytes. */
export class NativeMessageDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: unknown[] = [];
    while (this.buffered.byteLength >= 4) {
      const length = this.buffered.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        this.buffered = Buffer.alloc(0);
        throw new Error(`Native Messaging frame exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes.`);
      }
      if (this.buffered.byteLength < length + 4) break;
      const payload = this.buffered.subarray(4, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      try {
        messages.push(JSON.parse(payload.toString("utf8")));
      } catch {
        throw new Error("Native Messaging input is not valid JSON.");
      }
    }
    return messages;
  }

  hasIncompleteFrame(): boolean {
    return this.buffered.byteLength > 0;
  }
}

export function encodeNativeHostMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const output = Buffer.alloc(4 + payload.byteLength);
  output.writeUInt32LE(payload.byteLength, 0);
  payload.copy(output, 4);
  return output;
}

export interface NativeHostResponseWriter {
  send(message: unknown): Promise<void>;
}

export interface NativeHostApplication {
  handle(
    message: unknown,
    response: NativeHostResponseWriter,
    context: { homeDir?: string },
  ): Promise<void>;
}

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
    return encodeNativeHostMessage({
      ok: false,
      error: "Native Messaging input is missing the message length prefix.",
    });
  }
  const messageLength = buffer.readUInt32LE(0);
  const messageBytes = buffer.subarray(4);
  if (messageBytes.byteLength !== messageLength) {
    return encodeNativeHostMessage({
      ok: false,
      error: "Native Messaging input length does not match the payload.",
    });
  }
  let message: unknown;
  try {
    message = JSON.parse(messageBytes.toString("utf8"));
  } catch {
    return encodeNativeHostMessage({
      ok: false,
      error: "Native Messaging input is not valid JSON.",
    });
  }
  return encodeNativeHostMessage(
    await handleNativeHostMessage(message as NativeHostMessage, input),
  );
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

export function createNativeHostApplication(input: {
  homeDir?: string;
  modelClientForWorkspace?: (workspaceRoot: string) => ModelClient | undefined;
}): NativeHostApplication {
  const { homeDir } = input;
  const controllers = new Map<string, AbortController>();
  const learningLauncher = createBrowserLearningLauncher({
    homeDir,
    modelClientForWorkspace: (workspaceRoot) =>
      input.modelClientForWorkspace?.(workspaceRoot) ??
      createDeferredLiveModelClient(
        {
          workflow: "learning",
          homeDir,
          workspaceRoot,
          env: process.env,
        },
        createDeepSeekLiveModelClient,
      ),
  });
  const workbench = createBrowserWorkbench({
    resolveProfile: (profileId) => resolveWorkspaceProfile({ homeDir, profileId }),
    startLearning: learningLauncher.startLearning,
    startPageAnswer: learningLauncher.startPageAnswer,
  });

  return {
    async handle(message, response, context) {
      if (!isRecord(message)) {
        await response.send({ ok: false, error: "Native Messaging command must be an object." });
        return;
      }
      if (message.type === "listWorkspaceProfiles") {
        const listing = await listWorkspaceProfiles({ homeDir: context.homeDir });
        await response.send({ profiles: toExtensionWorkspaceProfileProjection(listing) });
        return;
      }
      if (message.type === "cancel") {
        const invocationId = typeof message.invocationId === "string" ? message.invocationId : "";
        controllers.get(invocationId)?.abort();
        return;
      }
      if (message.type === "browserInvocation") {
        let request: BrowserInvocationRequest;
        try {
          request = validateBrowserInvocationRequest(message.request);
        } catch (error) {
          // A protocol mismatch (or any other pre-parse rejection) never
          // reaches runBrowserInvocation's frame stream, so it is reported
          // here as the same launch_rejected shape the extension already
          // knows how to render, rather than a bare {ok:false} the panel
          // would silently drop.
          const raw = isRecord(message.request) ? message.request : {};
          await response.send({
            type: "launch_rejected",
            conversationId: typeof raw.conversationId === "string" ? raw.conversationId : "",
            invocationId: typeof raw.invocationId === "string" ? raw.invocationId : "",
            seq: 0,
            reason: error instanceof Error ? error.message : String(error),
            ...(error instanceof BrowserProtocolValidationError
              ? { code: error.reason }
              : {}),
          });
          return;
        }
        const controller = new AbortController();
        controllers.set(request.invocationId, controller);
        try {
          for await (const frame of runBrowserInvocation(request, workbench, {
            homeDir: context.homeDir,
            signal: controller.signal,
          })) {
            await response.send(frame);
          }
        } finally {
          controllers.delete(request.invocationId);
        }
        return;
      }
      await response.send(await handleNativeHostMessage(message as NativeHostMessage, context));
    },
  };
}

export async function runNativeHostStdio(input: {
  stdin: Readable;
  stdout: Writable;
  homeDir?: string;
  application?: NativeHostApplication;
}): Promise<void> {
  const decoder = new NativeMessageDecoder();
  const application = input.application ?? createNativeHostApplication({ homeDir: input.homeDir });
  const active = new Set<Promise<void>>();
  const response: NativeHostResponseWriter = {
    send: async (message) => {
      input.stdout.write(encodeNativeHostMessage(message));
    },
  };

  for await (const chunk of input.stdin) {
    let messages: unknown[];
    try {
      messages = decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (error) {
      await response.send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const message of messages) {
      const task = application
        .handle(message, response, { homeDir: input.homeDir })
        .catch(async (error: unknown) => {
          await response.send({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      active.add(task);
      void task.finally(() => active.delete(task));
    }
  }

  if (decoder.hasIncompleteFrame()) {
    await response.send({
      ok: false,
      error: "Native Messaging transport ended with an incomplete frame.",
    });
  }
  await Promise.all([...active]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runNativeHostStdio({
    stdin: process.stdin,
    stdout: process.stdout,
    homeDir: process.env.HOME,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(encodeNativeHostMessage({ ok: false, error: message }));
  });
}
