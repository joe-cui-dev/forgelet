import { expect, test } from "@jest/globals";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { loadCurrentBrowserSnapshot } from "../../src/browser/index.js";
import {
  handleNativeHostBuffer,
  handleNativeHostMessage,
  runNativeHostStdio,
} from "../../src/native-host/index.js";

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

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
