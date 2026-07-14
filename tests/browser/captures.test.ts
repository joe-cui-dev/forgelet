import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  browserCapturePath,
  persistBrowserWorkbenchCapture,
  readBrowserWorkbenchCapture,
} from "../../src/browser/captures.js";

test("a Workbench capture persists as an auditable file keyed by captureId", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-captures-"));

  const contentPath = await persistBrowserWorkbenchCapture({
    workspaceRoot,
    capture: {
      captureId: "6f9d2c4e-8a13-4b1f-9c60-1c2c4a5d0e7b",
      url: "https://example.com/docs",
      title: "Example Docs",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      contentHash: "a".repeat(64),
      contentBytes: 36,
      truncated: true,
      content: "# Example Docs\n\nUseful page content.",
    },
  });

  expect(contentPath).toBe(
    join(workspaceRoot, ".forgelet", "browser", "6f9d2c4e-8a13-4b1f-9c60-1c2c4a5d0e7b.json"),
  );
  expect(contentPath).toBe(
    browserCapturePath(workspaceRoot, "6f9d2c4e-8a13-4b1f-9c60-1c2c4a5d0e7b"),
  );
  expect(JSON.parse(await readFile(contentPath, "utf8"))).toEqual({
    captureId: "6f9d2c4e-8a13-4b1f-9c60-1c2c4a5d0e7b",
    url: "https://example.com/docs",
    title: "Example Docs",
    capturedAt: "2026-07-12T00:00:00.000Z",
    contentKind: "mainText",
    contentHash: "a".repeat(64),
    contentBytes: 36,
    truncated: true,
    content: "# Example Docs\n\nUseful page content.",
  });
});

test("a persisted Workbench capture reloads verbatim", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-captures-reload-"));
  await persistBrowserWorkbenchCapture({
    workspaceRoot,
    capture: {
      captureId: "capture_1",
      url: "https://example.com/docs",
      title: "Example Docs",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      contentHash: "a".repeat(64),
      contentBytes: 36,
      truncated: false,
      content: "# Example Docs\n\nUseful page content.",
    },
  });

  const capture = await readBrowserWorkbenchCapture(workspaceRoot, "capture_1");

  expect(capture).toEqual({
    captureId: "capture_1",
    url: "https://example.com/docs",
    title: "Example Docs",
    capturedAt: "2026-07-12T00:00:00.000Z",
    contentKind: "mainText",
    contentHash: "a".repeat(64),
    contentBytes: 36,
    truncated: false,
    content: "# Example Docs\n\nUseful page content.",
  });
});

test("reloading a missing capture throws", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-captures-missing-"));

  await expect(
    readBrowserWorkbenchCapture(workspaceRoot, "capture_missing"),
  ).rejects.toThrow();
});

test("reloading a malformed capture file throws", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-captures-malformed-"));
  const capturePath = browserCapturePath(workspaceRoot, "capture_bad");
  await mkdir(dirname(capturePath), { recursive: true });
  await writeFile(capturePath, JSON.stringify({ captureId: "capture_bad" }), "utf8");

  await expect(
    readBrowserWorkbenchCapture(workspaceRoot, "capture_bad"),
  ).rejects.toThrow(/malformed/);
});

test("a capture with a path-traversal captureId is rejected before any file is written", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-captures-unsafe-"));

  await expect(
    persistBrowserWorkbenchCapture({
      workspaceRoot,
      capture: {
        captureId: "../../escape",
        url: "https://example.com/docs",
        title: "Example Docs",
        capturedAt: "2026-07-12T00:00:00.000Z",
        contentKind: "mainText",
        contentHash: "a".repeat(64),
        contentBytes: 36,
        truncated: false,
        content: "# Example Docs\n\nUseful page content.",
      },
    }),
  ).rejects.toThrow(/captureId/);
});
