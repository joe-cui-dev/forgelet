import { expect, test } from "@jest/globals";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserCapturePath,
  persistBrowserWorkbenchCapture,
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
