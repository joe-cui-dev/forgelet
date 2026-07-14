import { expect, test } from "@jest/globals";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { loadCurrentBrowserSnapshot } from "../../src/browser/index.js";
import { approveWorkspaceProfile } from "../../src/browser/workspaceProfiles.js";
import {
  NativeMessageDecoder,
  createNativeHostApplication,
  encodeNativeHostMessage,
  handleNativeHostBuffer,
  handleNativeHostMessage,
  runNativeHostStdio,
} from "../../src/native-host/index.js";
import type { ModelClient, ModelTurnInput, ModelTurnOutput } from "../../src/types.js";

test("Native Messaging host writes a selected-text browser snapshot", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-native-host-home-"));

  const response = await handleNativeHostMessage(
    {
      type: "shareCurrentPage",
      payload: {
        url: "https://example.com/issue/123",
        title: "Fix checkout bug",
        capturedAt: "2026-07-02T00:00:00.000Z",
        selectedText: "The checkout button throws after payment auth.",
      },
    },
    { homeDir },
  );

  expect(response).toMatchObject({
    ok: true,
    snapshotPath: join(homeDir, ".forgelet", "browser", "current-page.json"),
    url: "https://example.com/issue/123",
    title: "Fix checkout bug",
    contentKind: "selectedText",
    contentBytes: 46,
    capturedAt: "2026-07-02T00:00:00.000Z",
  });
  expect(response).toHaveProperty("contentHash");
  expect(JSON.stringify(response)).not.toContain(
    "The checkout button throws after payment auth.",
  );
  if (!response.ok) throw new Error(response.error);

  const rawSnapshot = JSON.parse(
    await readFile(join(homeDir, ".forgelet", "browser", "current-page.json"), "utf8"),
  );
  expect(rawSnapshot).toEqual({
    url: "https://example.com/issue/123",
    title: "Fix checkout bug",
    capturedAt: "2026-07-02T00:00:00.000Z",
    selectedText: "The checkout button throws after payment auth.",
  });

  const loaded = await loadCurrentBrowserSnapshot({
    homeDir,
    now: new Date("2026-07-02T00:01:00.000Z"),
  });
  expect(loaded.contentKind).toBe("selectedText");
  expect(loaded.content).toBe("The checkout button throws after payment auth.");
  expect(loaded.contentHash).toBe(response.contentHash);
});

test("Native Messaging host handles framed stdio messages", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-native-host-stdio-home-"));
  const message = Buffer.from(
    JSON.stringify({
      type: "shareCurrentPage",
      payload: {
        url: "https://example.com/docs",
        title: "Readable API Docs",
        capturedAt: "2026-07-02T00:00:00.000Z",
        mainText: "Install the SDK before creating a client.",
      },
    }),
    "utf8",
  );
  const input = Buffer.alloc(4 + message.byteLength);
  input.writeUInt32LE(message.byteLength, 0);
  message.copy(input, 4);

  const output = await handleNativeHostBuffer(input, { homeDir });

  const responseLength = output.readUInt32LE(0);
  const response = JSON.parse(output.subarray(4).toString("utf8"));
  expect(responseLength).toBe(output.byteLength - 4);
  expect(response).toMatchObject({
    ok: true,
    title: "Readable API Docs",
    contentKind: "mainText",
    contentBytes: 41,
  });
});

test("Native Messaging host responds after one framed message without waiting for stdin EOF", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-native-host-open-stdio-home-"));
  const message = Buffer.from(
    JSON.stringify({
      type: "shareCurrentPage",
      payload: {
        url: "https://example.com/open-stdio",
        title: "Open stdio",
        capturedAt: "2026-07-02T00:00:00.000Z",
        mainText: "The host should respond before stdin closes.",
      },
    }),
    "utf8",
  );
  const input = Buffer.alloc(4 + message.byteLength);
  input.writeUInt32LE(message.byteLength, 0);
  message.copy(input, 4);
  const stdin = new PassThrough();
  const outputChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });

  const runPromise = runNativeHostStdio({ stdin, stdout, homeDir });
  stdin.write(input);
  await waitFor(() => outputChunks.length > 0);

  const output = Buffer.concat(outputChunks);
  const response = JSON.parse(output.subarray(4).toString("utf8"));
  expect(response).toMatchObject({ ok: true, title: "Open stdio" });
  stdin.end();
  await runPromise;
});

test("Native Messaging decoder handles split headers, split payloads, and multiple frames", () => {
  const first = encodeNativeHostMessage({ type: "first", invocationId: "one" });
  const second = encodeNativeHostMessage({ type: "second", invocationId: "two" });
  const decoder = new NativeMessageDecoder();

  expect(decoder.push(first.subarray(0, 2))).toEqual([]);
  expect(decoder.push(first.subarray(2, first.byteLength - 3))).toEqual([]);
  expect(decoder.push(Buffer.concat([first.subarray(first.byteLength - 3), second.subarray(0, 3)]))).toEqual([
    { type: "first", invocationId: "one" },
  ]);
  expect(decoder.push(second.subarray(3))).toEqual([
    { type: "second", invocationId: "two" },
  ]);
});

test("Native Messaging host streams multiple application responses and forwards cancel frames by invocation identity", async () => {
  const stdin = new PassThrough();
  const outputChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  const delivered: Array<{ type: string; invocationId: string }> = [];
  const runPromise = runNativeHostStdio({
    stdin,
    stdout,
    application: {
      async handle(message, response) {
        const frame = message as { type: string; invocationId: string };
        delivered.push(frame);
        await response.send({
          type: `${frame.type}_received`,
          invocationId: frame.invocationId,
        });
      },
    },
  });

  stdin.write(
    Buffer.concat([
      encodeNativeHostMessage({ type: "invoke", invocationId: "first" }),
      encodeNativeHostMessage({ type: "invoke", invocationId: "second" }),
      encodeNativeHostMessage({ type: "cancel", invocationId: "second" }),
    ]),
  );
  await waitFor(() => outputChunks.length >= 3);

  expect(delivered).toEqual([
    { type: "invoke", invocationId: "first" },
    { type: "invoke", invocationId: "second" },
    { type: "cancel", invocationId: "second" },
  ]);
  expect(decodeFrames(Buffer.concat(outputChunks))).toEqual([
    { type: "invoke_received", invocationId: "first" },
    { type: "invoke_received", invocationId: "second" },
    { type: "cancel_received", invocationId: "second" },
  ]);
  stdin.end();
  await runPromise;
});

function decodeFrames(buffer: Buffer): unknown[] {
  const decoder = new NativeMessageDecoder();
  return decoder.push(buffer);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A model turn that hangs until released, or rejects the moment its signal
 * aborts — the seam needed to drive real concurrent Learning launches
 * through their in-flight window in a deterministic way. */
class GateModelClient implements ModelClient {
  started = false;
  private release: (() => void) | undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(private readonly content: string) {}

  open(): void {
    this.release?.();
  }

  async createTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      this.gate.then(resolve);
      input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    return { content: this.content, toolCalls: [] };
  }
}

function rootBrowserInvocationMessage(input: {
  conversationId: string;
  invocationId: string;
  workspaceProfileId: string;
  content: string;
}): { type: "browserInvocation"; request: Record<string, unknown> } {
  return {
    type: "browserInvocation",
    request: {
      version: 3,
      kind: "root",
      conversationId: input.conversationId,
      actionId: `${input.invocationId}_action`,
      invocationId: input.invocationId,
      workspaceProfileId: input.workspaceProfileId,
      capture: {
        url: "https://example.com/page",
        title: "Example",
        content: input.content,
        contentKind: "mainText",
        contentHash: "a".repeat(64),
        contentBytes: Buffer.byteLength(input.content, "utf8"),
        captureId: `${input.invocationId}_capture`,
        capturedAt: "2026-07-14T00:00:00.000Z",
        captureReadyMs: 1,
        truncated: false,
      },
    },
  };
}

test("Native Host rejects a v2 Browser Workbench invocation with a typed v3 mismatch frame carrying its identity", async () => {
  const application = createNativeHostApplication({ homeDir: await mkdtemp(join(tmpdir(), "forgelet-native-host-v2-home-")) });
  const sent: Record<string, unknown>[] = [];
  await application.handle(
    {
      type: "browserInvocation",
      request: {
        version: 2,
        kind: "root",
        conversationId: "conversation_1",
        actionId: "action_1",
        invocationId: "invocation_1",
        workspaceProfileId: "profile_1",
      },
    },
    { send: async (message) => { sent.push(message as Record<string, unknown>); } },
    {},
  );
  expect(sent).toEqual([
    {
      type: "launch_rejected",
      conversationId: "conversation_1",
      invocationId: "invocation_1",
      seq: 0,
      reason: expect.stringMatching(/rebuild.*reload.*install-host/i),
    },
  ]);
});

test("Native Host runs two Browser Workbench attempts concurrently and scopes cancel to the named invocation", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-native-host-concurrency-home-"));
  const workspaceA = await mkdtemp(join(tmpdir(), "forgelet-native-host-workspace-a-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "forgelet-native-host-workspace-b-"));
  const profileA = await approveWorkspaceProfile({ homeDir, cwd: workspaceA, name: "A" });
  const profileB = await approveWorkspaceProfile({ homeDir, cwd: workspaceB, name: "B" });

  const clientA = new GateModelClient("## Summary\nA summary.\n\n## Key Concepts\n- A");
  const clientB = new GateModelClient("## Summary\nB summary.\n\n## Key Concepts\n- B");
  const clients = new Map<string, ModelClient>([
    [profileA.path, clientA],
    [profileB.path, clientB],
  ]);

  const application = createNativeHostApplication({
    homeDir,
    modelClientForWorkspace: (workspaceRoot) => clients.get(workspaceRoot),
  });

  const framesA: Record<string, unknown>[] = [];
  const framesB: Record<string, unknown>[] = [];
  const responseA = { send: async (message: unknown) => { framesA.push(message as Record<string, unknown>); } };
  const responseB = { send: async (message: unknown) => { framesB.push(message as Record<string, unknown>); } };

  const handleA = application.handle(
    rootBrowserInvocationMessage({ conversationId: "conv_a", invocationId: "inv_a", workspaceProfileId: profileA.id, content: "Page A content." }),
    responseA,
    { homeDir },
  );
  const handleB = application.handle(
    rootBrowserInvocationMessage({ conversationId: "conv_b", invocationId: "inv_b", workspaceProfileId: profileB.id, content: "Page B content." }),
    responseB,
    { homeDir },
  );

  await waitFor(() => clientA.started && clientB.started);

  await application.handle({ type: "cancel", invocationId: "inv_a" }, { send: async () => {} }, { homeDir });
  clientA.open();
  clientB.open();

  await Promise.all([handleA, handleB]);

  expect(framesA.every((frame) => frame.invocationId === "inv_a")).toBe(true);
  expect(framesB.every((frame) => frame.invocationId === "inv_b")).toBe(true);
  expect(framesA.at(-1)).toMatchObject({ type: "stopped" });
  expect(framesB.at(-1)).toMatchObject({ type: "page_brief_completed" });

  // The terminal frame already released invocation A's controller; a stale
  // cancel for it afterward must be a harmless no-op.
  await expect(
    application.handle({ type: "cancel", invocationId: "inv_a" }, { send: async () => {} }, { homeDir }),
  ).resolves.toBeUndefined();
});

test("Native Messaging transport loss does not implicitly stop an in-flight attempt", async () => {
  const stdin = new PassThrough();
  const outputChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  let releaseHandle: (() => void) | undefined;
  let handleSettled = false;
  const runPromise = runNativeHostStdio({
    stdin,
    stdout,
    application: {
      async handle(_message, response) {
        await new Promise<void>((resolve) => {
          releaseHandle = resolve;
        });
        handleSettled = true;
        await response.send({ type: "still_running_after_transport_loss" });
      },
    },
  });

  stdin.write(encodeNativeHostMessage({ type: "invoke", invocationId: "inv_1" }));
  await waitFor(() => releaseHandle !== undefined);

  // Chrome closing the Native Port ends stdin; that alone must not force
  // completion or read as an implicit user Stop.
  stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(handleSettled).toBe(false);

  releaseHandle?.();
  await runPromise;

  expect(handleSettled).toBe(true);
  expect(decodeFrames(Buffer.concat(outputChunks))).toEqual([
    { type: "still_running_after_transport_loss" },
  ]);
});
