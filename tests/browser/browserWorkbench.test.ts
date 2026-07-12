import { expect, test } from "@jest/globals";
import { createBrowserWorkbench } from "../../src/browserWorkbench/index.js";
import { runBrowserInvocation, type BrowserRunFrame } from "../../src/browser/protocol.js";

async function collect(frames: AsyncIterable<BrowserRunFrame>): Promise<BrowserRunFrame[]> {
  const values: BrowserRunFrame[] = [];
  for await (const frame of frames) values.push(frame);
  return values;
}

test("Browser Workbench resolves an approved profile and launches answer-once Learning with one browser source", async () => {
  let authorized: Record<string, unknown> | undefined;
  const workbench = createBrowserWorkbench({
    async resolveProfile(profileId) {
      expect(profileId).toBe("profile_1");
      return { id: profileId, label: "Forgelet", path: "/workspace/forgelet" };
    },
    async startLearning(input) {
      authorized = input as unknown as Record<string, unknown>;
      await input.onLiveEvent({
        type: "session_ready",
        sessionId: "sess_browser_1",
        tracePath: "/workspace/forgelet/.forgelet/sessions/sess_browser_1.jsonl",
      });
      return {
        status: "completed",
        summary: "## Summary\nA concise page summary.",
        learningPack: {
          summary: "A concise page summary.",
          keyConcepts: "- First concept",
          sourceLinks: "- browser: Example Docs",
          openQuestions: "- None",
          reviewPrompts: "- Recall the first concept",
        },
      };
    },
  });

  const frames = await collect(runBrowserInvocation({
    version: 1,
    actionId: "action_1",
    invocationId: "invocation_1",
    payload: {
      workspaceProfileId: "profile_1",
      capture: {
        url: "https://example.com/docs",
        title: "Example Docs",
        content: "# Example Docs\n\nUseful page content.",
        contentKind: "mainText",
        contentHash: "a".repeat(64),
        contentBytes: 36,
        captureId: "capture_1",
        capturedAt: "2026-07-12T00:00:00.000Z",
        captureReadyMs: 12,
      },
    },
  }, workbench, { homeDir: await makeHomeDir() }));

  expect(authorized).toMatchObject({
    workspaceRoot: "/workspace/forgelet",
    executionPolicy: "answer_once",
    trigger: { actionId: "action_1", workspaceProfileId: "profile_1", captureId: "capture_1" },
  });
  expect(authorized?.browserSnapshot).toMatchObject({
    url: "https://example.com/docs",
    content: "# Example Docs\n\nUseful page content.",
  });
  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "session_ready",
    "completed",
  ]);
  expect(frames.at(-1)).toMatchObject({
    type: "completed",
    learningPack: { summary: "A concise page summary." },
  });
});

test("Browser Workbench rejects paths, workflow/provider fields, and unknown profiles before a Session starts", async () => {
  let launchCount = 0;
  const workbench = createBrowserWorkbench({
    async resolveProfile() {
      throw new Error("Unknown Workspace Profile: profile_unknown");
    },
    async startLearning() {
      launchCount += 1;
      return { status: "completed", summary: "unexpected" };
    },
  });

  const frames = await collect(runBrowserInvocation({
    version: 1,
    actionId: "action_bad",
    invocationId: "invocation_bad",
    payload: {
      workspaceProfileId: "profile_unknown",
      workspacePath: "/arbitrary/path",
      workflow: "coding",
      provider: "untrusted",
      capture: {},
    },
  }, workbench, { homeDir: await makeHomeDir() }));

  expect(launchCount).toBe(0);
  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "launch_rejected",
  ]);
});

test("Browser Workbench rejects a path-traversal captureId before a Session starts", async () => {
  let launchCount = 0;
  const workbench = createBrowserWorkbench({
    async resolveProfile(profileId) {
      return { id: profileId, label: "Forgelet", path: "/workspace/forgelet" };
    },
    async startLearning() {
      launchCount += 1;
      return { status: "completed", summary: "unexpected" };
    },
  });

  const frames = await collect(runBrowserInvocation({
    version: 1,
    actionId: "action_traversal",
    invocationId: "invocation_traversal",
    payload: {
      workspaceProfileId: "profile_1",
      capture: {
        url: "https://example.com/docs",
        title: "Example Docs",
        content: "# Example Docs\n\nUseful page content.",
        contentKind: "mainText",
        contentHash: "a".repeat(64),
        contentBytes: 36,
        captureId: "../../../etc/passwd",
        capturedAt: "2026-07-12T00:00:00.000Z",
        captureReadyMs: 12,
      },
    },
  }, workbench, { homeDir: await makeHomeDir() }));

  expect(launchCount).toBe(0);
  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "launch_rejected",
  ]);
  expect(frames.at(-1)).toMatchObject({ reason: expect.stringContaining("captureId") });
});

async function makeHomeDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtemp(join(tmpdir(), "forgelet-workbench-home-"));
}
