import { expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserWorkbench } from "../../src/browserWorkbench/index.js";
import {
  BrowserFollowUpPreflightError,
  preflightBrowserFollowUp,
} from "../../src/browserWorkbench/followUpPreflight.js";
import { persistBrowserWorkbenchCapture } from "../../src/browser/captures.js";
import { runBrowserInvocation, type BrowserRunFrame } from "../../src/browser/protocol.js";
import { createBrowserLearningLauncher } from "../../src/sessionLauncher/learning.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { findSessionTracePath, readTraceFile } from "../../src/trace/index.js";

const request = {
  version: 3 as const, kind: "root" as const, conversationId: "conversation_1", actionId: "action_1", invocationId: "invocation_1", workspaceProfileId: "profile_1",
  capture: { url: "https://example.com/docs", title: "Example Docs", content: "# Example Docs\n\nUseful page content.", contentKind: "mainText" as const, contentHash: "a".repeat(64), contentBytes: 36, captureId: "capture_1", capturedAt: "2026-07-12T00:00:00.000Z", captureReadyMs: 12, truncated: false },
};
async function collect(items: AsyncIterable<BrowserRunFrame>): Promise<BrowserRunFrame[]> { const all: BrowserRunFrame[] = []; for await (const item of items) all.push(item); return all; }
async function home(): Promise<string> { return mkdtemp(join(tmpdir(), "forgelet-workbench-home-")); }

test("Browser Workbench resolves an approved profile and launches answer-once Page Brief with one browser source", async () => {
  let authorized: Record<string, unknown> | undefined;
  const workbench = createBrowserWorkbench({
    async resolveProfile(id) { return { id, label: "Forgelet", path: "/workspace/forgelet" }; },
    async startLearning(input) { authorized = input as unknown as Record<string, unknown>; await input.onLiveEvent({ type: "session_ready", sessionId: "sess_1", tracePath: "/tmp/sess_1.jsonl" }); return { status: "completed", summary: "done", pageBrief: { summary: "Brief", keyConcepts: "- Key" } }; },
    async startPageAnswer() { throw new Error("unexpected"); },
  });
  const frames = await collect(runBrowserInvocation(request, workbench, { homeDir: await home() }));
  expect(authorized).toMatchObject({ workspaceRoot: "/workspace/forgelet", executionPolicy: "answer_once", trigger: { kind: "root", conversationId: "conversation_1", captureId: "capture_1" } });
  expect(frames.at(-1)).toMatchObject({ type: "page_brief_completed", pageBrief: { summary: "Brief" } });
});

test("Browser Workbench snapshots the requested output language into its Page Brief task", async () => {
  let task = "";
  const workbench = createBrowserWorkbench({ async resolveProfile(id) { return { id, label: "Forgelet", path: "/workspace" }; }, async startLearning(input) { task = input.task; return { status: "completed", summary: "done", pageBrief: { summary: "简明", keyConcepts: "- 概念" } }; }, async startPageAnswer() { throw new Error("unexpected"); } });
  await collect(runBrowserInvocation({ ...request, actionId: "action_lang", invocationId: "invocation_lang", outputLanguage: "zh-CN" }, workbench, { homeDir: await home() }));
  expect(task).toContain("Write all body text in zh-CN");
});

function frameSessionId(frames: BrowserRunFrame[]): string {
  const ready = frames.find(
    (frame): frame is Extract<BrowserRunFrame, { type: "session_ready" }> =>
      frame.type === "session_ready",
  );
  if (!ready) throw new Error("Expected a session_ready frame.");
  return ready.sessionId;
}

async function readSessionTrace(workspaceRoot: string, sessionId: string) {
  return readTraceFile(await findSessionTracePath(workspaceRoot, sessionId));
}

function eventOfType(
  events: Awaited<ReturnType<typeof readSessionTrace>>,
  type: string,
) {
  return events.find((event) => event.type === type);
}

test("root, root Retry, follow-up, and follow-up Retry all launch through the same authorized boundary with correct lineage and Trace metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-workbench-e2e-"));
  const modelClient = new FakeModelClient([
    { content: "## Summary\nRoot summary.\n\n## Key Concepts\nConcept.", toolCalls: [] },
    { content: "## Summary\nRetry summary.\n\n## Key Concepts\nConcept.", toolCalls: [] },
    { content: "## Answer\nThe sky is blue.\n\n## Evidence\n- Useful page content.", toolCalls: [] },
    { content: "## Answer\nStill blue.\n\n## Evidence\n- Useful page content.", toolCalls: [] },
  ]);
  const launcher = createBrowserLearningLauncher({
    modelClientForWorkspace: () => modelClient,
  });
  const workbench = createBrowserWorkbench({
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
    startLearning: launcher.startLearning,
    startPageAnswer: launcher.startPageAnswer,
  });
  const homeDir = await home();

  // Root Retry and every follow-up reload the persisted capture from disk and
  // verify its content hash (WP7), so this fixture needs a real hash rather
  // than the placeholder used by the fake-launcher tests above.
  const request = {
    version: 3 as const,
    kind: "root" as const,
    conversationId: "conversation_1",
    actionId: "action_1",
    invocationId: "invocation_1",
    workspaceProfileId: "profile_1",
    capture: {
      url: "https://example.com/docs",
      title: "Example Docs",
      content: "# Example Docs\n\nUseful page content.",
      contentKind: "mainText" as const,
      contentHash: createHash("sha256")
        .update("# Example Docs\n\nUseful page content.")
        .digest("hex"),
      contentBytes: 36,
      captureId: "capture_1",
      capturedAt: "2026-07-12T00:00:00.000Z",
      captureReadyMs: 12,
      truncated: false,
    },
  };

  const rootFrames = await collect(runBrowserInvocation(request, workbench, { homeDir }));
  expect(rootFrames.at(-1)).toMatchObject({
    type: "page_brief_completed",
    pageBrief: { summary: "Root summary." },
  });
  const rootSessionId = frameSessionId(rootFrames);

  const rootRetryFrames = await collect(
    runBrowserInvocation(
      {
        version: 3 as const,
        kind: "root_retry" as const,
        conversationId: "conversation_1",
        actionId: "action_retry",
        invocationId: "invocation_retry",
        workspaceProfileId: "profile_1",
        captureId: "capture_1",
      },
      workbench,
      { homeDir },
    ),
  );
  expect(rootRetryFrames.at(-1)).toMatchObject({
    type: "page_brief_completed",
    pageBrief: { summary: "Retry summary." },
  });
  const rootRetrySessionId = frameSessionId(rootRetryFrames);
  expect(rootRetrySessionId).not.toBe(rootSessionId);

  const followUpFrames = await collect(
    runBrowserInvocation(
      {
        version: 3 as const,
        kind: "follow_up" as const,
        conversationId: "conversation_1",
        actionId: "action_f1",
        invocationId: "invocation_f1",
        workspaceProfileId: "profile_1",
        captureId: "capture_1",
        rootSessionId,
        parentSessionId: rootSessionId,
        question: "Why is the sky blue?",
      },
      workbench,
      { homeDir },
    ),
  );
  expect(followUpFrames.at(-1)).toMatchObject({
    type: "page_answer_completed",
    pageAnswer: { answer: "The sky is blue.", groundingStatus: "supported", evidence: ["Useful page content."] },
  });
  const followUpSessionId = frameSessionId(followUpFrames);

  const followUpRetryFrames = await collect(
    runBrowserInvocation(
      {
        version: 3 as const,
        kind: "follow_up_retry" as const,
        conversationId: "conversation_1",
        actionId: "action_f1_retry",
        invocationId: "invocation_f1_retry",
        workspaceProfileId: "profile_1",
        captureId: "capture_1",
        rootSessionId,
        parentSessionId: rootSessionId,
        question: "Why is the sky blue?",
      },
      workbench,
      { homeDir },
    ),
  );
  expect(followUpRetryFrames.at(-1)).toMatchObject({
    type: "page_answer_completed",
    pageAnswer: { answer: "Still blue.", groundingStatus: "supported" },
  });
  const followUpRetrySessionId = frameSessionId(followUpRetryFrames);
  expect(followUpRetrySessionId).not.toBe(followUpSessionId);

  const rootTrace = await readSessionTrace(workspaceRoot, rootSessionId);
  expect(eventOfType(rootTrace, "session_started")?.payload).toMatchObject({
    workflow: "learning",
    deliverableShape: "pageBrief",
    trigger: {
      kind: "root",
      conversationId: "conversation_1",
      invocationId: "invocation_1",
      captureId: "capture_1",
      workspaceProfileId: "profile_1",
    },
  });
  expect(eventOfType(rootTrace, "final_summary")?.payload.finalContent).toBe(
    "## Summary\nRoot summary.\n\n## Key Concepts\nConcept.",
  );

  const rootRetryTrace = await readSessionTrace(workspaceRoot, rootRetrySessionId);
  expect(eventOfType(rootRetryTrace, "session_started")?.payload).toMatchObject({
    workflow: "learning",
    deliverableShape: "pageBrief",
    trigger: {
      kind: "root_retry",
      conversationId: "conversation_1",
      invocationId: "invocation_retry",
      captureId: "capture_1",
      workspaceProfileId: "profile_1",
    },
  });

  const followUpTrace = await readSessionTrace(workspaceRoot, followUpSessionId);
  expect(eventOfType(followUpTrace, "session_started")?.payload).toMatchObject({
    workflow: "learning",
    deliverableShape: "pageAnswer",
    trigger: {
      kind: "follow_up",
      conversationId: "conversation_1",
      invocationId: "invocation_f1",
      captureId: "capture_1",
      workspaceProfileId: "profile_1",
      rootSessionId,
      parentSessionId: rootSessionId,
    },
    continuation: { sourceSessionId: rootSessionId },
  });
  expect(eventOfType(followUpTrace, "user_task")?.payload.task).toBe(
    "Why is the sky blue?",
  );
  expect(eventOfType(followUpTrace, "final_summary")?.payload.finalContent).toBe(
    "## Answer\nThe sky is blue.\n\n## Evidence\n- Useful page content.",
  );

  const followUpRetryTrace = await readSessionTrace(workspaceRoot, followUpRetrySessionId);
  expect(eventOfType(followUpRetryTrace, "session_started")?.payload).toMatchObject({
    trigger: {
      kind: "follow_up_retry",
      invocationId: "invocation_f1_retry",
      rootSessionId,
      parentSessionId: rootSessionId,
    },
  });
  expect(eventOfType(followUpRetryTrace, "user_task")?.payload.task).toBe(
    "Why is the sky blue?",
  );
});

async function writeRootSession(
  workspaceRoot: string,
  input: { sessionId: string; workspaceProfileId: string; captureId: string; conversationId: string },
): Promise<void> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${input.sessionId}.jsonl`),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-12T00:00:00.000Z",
        sessionId: input.sessionId,
        payload: {
          workflow: "learning",
          trigger: {
            kind: "root",
            conversationId: input.conversationId,
            captureId: input.captureId,
            workspaceProfileId: input.workspaceProfileId,
          },
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-12T00:00:00.000Z",
        sessionId: input.sessionId,
        payload: { task: "Summarize the page." },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-07-12T00:00:01.000Z",
        sessionId: input.sessionId,
        payload: { finalContent: "## Summary\nS.\n\n## Key Concepts\nK." },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-07-12T00:00:01.000Z",
        sessionId: input.sessionId,
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
}

async function sessionFileCount(workspaceRoot: string): Promise<number> {
  try {
    return (await readdir(join(workspaceRoot, ".forgelet", "sessions"))).length;
  } catch {
    return 0;
  }
}

test("follow-up preflight resolves the pinned profile, verified capture, and ordered history", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-happy-"));
  const content = "The captured page says the sky is blue.";
  await writeRootSession(workspaceRoot, {
    sessionId: "sess_root",
    workspaceProfileId: "profile_1",
    captureId: "capture_1",
    conversationId: "conv_1",
  });
  await persistBrowserWorkbenchCapture({
    workspaceRoot,
    capture: {
      captureId: "capture_1",
      url: "https://example.com/sky",
      title: "Sky",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      contentHash: createHash("sha256").update(content).digest("hex"),
      contentBytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
      content,
    },
  });

  const result = await preflightBrowserFollowUp({
    workspaceProfileId: "profile_1",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
  });

  expect(result.workspaceRoot).toBe(workspaceRoot);
  expect(result.workspaceProfileId).toBe("profile_1");
  expect(result.capture.content).toBe(content);
  expect(result.history.turns).toHaveLength(1);
  expect(result.history.rootSessionId).toBe("sess_root");
  expect(result.history.headSessionId).toBe("sess_root");
});

test("follow-up preflight stays pinned to the root Workspace Profile even if a different profile is requested", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-pin-"));
  await writeRootSession(workspaceRoot, {
    sessionId: "sess_root",
    workspaceProfileId: "profile_root",
    captureId: "capture_1",
    conversationId: "conv_1",
  });

  const launch = preflightBrowserFollowUp({
    workspaceProfileId: "profile_other",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
  });

  await expect(launch).rejects.toThrow(BrowserFollowUpPreflightError);
  await expect(launch).rejects.toMatchObject({ reason: "workspace_profile_unavailable" });
  expect(await sessionFileCount(workspaceRoot)).toBe(1);
});

test("a revoked or deleted profile rejects the follow-up launch", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-revoked-"));

  const launch = preflightBrowserFollowUp({
    workspaceProfileId: "profile_1",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    async resolveProfile() {
      throw new Error("Workspace Profile has been revoked.");
    },
  });

  await expect(launch).rejects.toThrow(BrowserFollowUpPreflightError);
  await expect(launch).rejects.toMatchObject({ reason: "workspace_profile_unavailable" });
  expect(await sessionFileCount(workspaceRoot)).toBe(0);
});

test("a missing persisted capture yields source_unavailable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-missing-capture-"));
  await writeRootSession(workspaceRoot, {
    sessionId: "sess_root",
    workspaceProfileId: "profile_1",
    captureId: "capture_1",
    conversationId: "conv_1",
  });

  const launch = preflightBrowserFollowUp({
    workspaceProfileId: "profile_1",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
  });

  await expect(launch).rejects.toMatchObject({ reason: "source_unavailable" });
  expect(await sessionFileCount(workspaceRoot)).toBe(1);
});

test("a capture identity/hash mismatch yields source_integrity_mismatch", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-hash-mismatch-"));
  await writeRootSession(workspaceRoot, {
    sessionId: "sess_root",
    workspaceProfileId: "profile_1",
    captureId: "capture_1",
    conversationId: "conv_1",
  });
  await persistBrowserWorkbenchCapture({
    workspaceRoot,
    capture: {
      captureId: "capture_1",
      url: "https://example.com/sky",
      title: "Sky",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      contentHash: "a".repeat(64),
      contentBytes: 10,
      truncated: false,
      content: "This content does not match the recorded hash.",
    },
  });

  const launch = preflightBrowserFollowUp({
    workspaceProfileId: "profile_1",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
  });

  await expect(launch).rejects.toMatchObject({ reason: "source_integrity_mismatch" });
  expect(await sessionFileCount(workspaceRoot)).toBe(1);
});

test("missing ancestor history yields conversation_history_unavailable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-history-"));
  // No root session Trace was ever written: the follow-up claims a head that
  // does not exist.
  const content = "Some captured page content.";
  await persistBrowserWorkbenchCapture({
    workspaceRoot,
    capture: {
      captureId: "capture_1",
      url: "https://example.com/sky",
      title: "Sky",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      contentHash: createHash("sha256").update(content).digest("hex"),
      contentBytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
      content,
    },
  });

  const launch = preflightBrowserFollowUp({
    workspaceProfileId: "profile_1",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
  });

  await expect(launch).rejects.toMatchObject({ reason: "conversation_history_unavailable" });
});

test("a missing ancestor mid-chain surfaces conversation_history_unavailable once the profile pin is satisfied", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-preflight-history-midchain-"));
  await writeRootSession(workspaceRoot, {
    sessionId: "sess_root",
    workspaceProfileId: "profile_1",
    captureId: "capture_1",
    conversationId: "conv_1",
  });
  const content = "Some captured page content.";
  await persistBrowserWorkbenchCapture({
    workspaceRoot,
    capture: {
      captureId: "capture_1",
      url: "https://example.com/sky",
      title: "Sky",
      capturedAt: "2026-07-12T00:00:00.000Z",
      contentKind: "mainText",
      contentHash: createHash("sha256").update(content).digest("hex"),
      contentBytes: Buffer.byteLength(content, "utf8"),
      truncated: false,
      content,
    },
  });

  const launch = preflightBrowserFollowUp({
    workspaceProfileId: "profile_1",
    conversationId: "conv_1",
    captureId: "capture_1",
    rootSessionId: "sess_root",
    // sess_f1_missing was never written: the declared head does not exist.
    headSessionId: "sess_f1_missing",
    async resolveProfile(id) {
      return { id, label: "Forgelet", path: workspaceRoot };
    },
  });

  await expect(launch).rejects.toMatchObject({ reason: "conversation_history_unavailable" });
  expect(await sessionFileCount(workspaceRoot)).toBe(1);
});
