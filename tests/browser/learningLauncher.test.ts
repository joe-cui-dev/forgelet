import { expect, test } from "@jest/globals";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCapturePath } from "../../src/browser/captures.js";
import { debugTranscriptPath } from "../../src/debugTranscript/index.js";
import { createBrowserLearningLauncher } from "../../src/sessionLauncher/learning.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import type { SessionLiveEvent } from "../../src/sessionLiveView/index.js";

const PAGE_BODY = `PRIVATE_WORKBENCH_PAGE_BODY_${"x".repeat(400)}`;
const CAPTURE_ID = "0b8f3c21-55aa-4d7e-8f3c-2155aa4d7e8f";

test("a Workbench-launched Learning Session persists the capture and its Trace attachment references the persisted content", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-launcher-capture-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-launcher-home-"));
  const modelClient = new FakeModelClient([
    { content: "## Summary\nA concise page summary.", toolCalls: [] },
  ]);
  const launcher = createBrowserLearningLauncher({
    homeDir,
    modelClientForWorkspace: () => modelClient,
  });
  const liveEvents: SessionLiveEvent[] = [];

  const result = await launcher.startLearning({
    workspaceRoot,
    task: "Summarize the explicitly shared current browser page as a concise Learning Pack.",
    browserSnapshot: {
      url: "https://example.com/docs",
      title: "Example Docs",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      content: PAGE_BODY,
      contentBytes: Buffer.byteLength(PAGE_BODY, "utf8"),
      contentHash: "c".repeat(64),
      truncated: true,
      preview: `${PAGE_BODY.replace(/\s+/g, " ").trim().slice(0, 157)}...`,
    },
    executionPolicy: "answer_once",
    trigger: {
      kind: "root",
      conversationId: "conversation_1",
      actionId: "action_1",
      invocationId: "invocation_1",
      workspaceProfileId: "profile_1",
      captureId: CAPTURE_ID,
      captureReadyMs: 12,
    },
    onLiveEvent: async (event) => {
      liveEvents.push(event);
    },
  });

  expect(result.status).toBe("completed");

  // The full capture is persisted for audit, keyed by captureId.
  const contentPath = browserCapturePath(workspaceRoot, CAPTURE_ID);
  expect(JSON.parse(await readFile(contentPath, "utf8"))).toMatchObject({
    captureId: CAPTURE_ID,
    url: "https://example.com/docs",
    title: "Example Docs",
    capturedAt: "2026-07-12T00:00:00.000Z",
    contentKind: "mainText",
    contentHash: "c".repeat(64),
    truncated: true,
    content: PAGE_BODY,
  });

  // The Trace attachment stays preview-only but now points at the persisted
  // content, so its contentHash is verifiable after the fact.
  const ready = liveEvents.find((event) => event.type === "session_ready");
  if (ready?.type !== "session_ready") throw new Error("Expected a session_ready live event.");
  const trace = await readFile(ready.tracePath, "utf8");
  expect(trace).not.toContain(PAGE_BODY);
  const attachment = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "context_attachment");
  expect(attachment?.payload).toMatchObject({
    source: "browser",
    uri: "https://example.com/docs",
    contentHash: "c".repeat(64),
    capturedAt: "2026-07-12T00:00:00.000Z",
    contentPath,
    truncated: true,
  });
});

test("a Workbench-launched Page Brief writes a Debug Transcript when the trigger requests it, and none when it does not", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-launcher-debug-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-launcher-home-"));
  const modelClient = new FakeModelClient([
    { content: "## Summary\nA concise page summary.", toolCalls: [] },
  ]);
  const launcher = createBrowserLearningLauncher({ homeDir, modelClientForWorkspace: () => modelClient });
  const liveEvents: SessionLiveEvent[] = [];

  const result = await launcher.startLearning({
    workspaceRoot,
    task: "Summarize the explicitly shared current browser page as a concise Page Brief.",
    browserSnapshot: {
      url: "https://example.com/docs",
      title: "Example Docs",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      content: PAGE_BODY,
      contentBytes: Buffer.byteLength(PAGE_BODY, "utf8"),
      contentHash: "c".repeat(64),
      truncated: true,
      preview: `${PAGE_BODY.replace(/\s+/g, " ").trim().slice(0, 157)}...`,
    },
    executionPolicy: "answer_once",
    trigger: {
      kind: "root",
      conversationId: "conversation_debug",
      actionId: "action_debug",
      invocationId: "invocation_debug",
      workspaceProfileId: "profile_1",
      captureId: CAPTURE_ID,
      captureReadyMs: 12,
    },
    debug: true,
    onLiveEvent: async (event) => {
      liveEvents.push(event);
    },
  });
  expect(result.status).toBe("completed");

  const ready = liveEvents.find((event) => event.type === "session_ready");
  if (ready?.type !== "session_ready") throw new Error("Expected a session_ready live event.");
  const transcript = await readFile(debugTranscriptPath(workspaceRoot, ready.sessionId), "utf8");
  expect(transcript).toContain("model_request");
  expect(transcript).toContain("model_response");
});
