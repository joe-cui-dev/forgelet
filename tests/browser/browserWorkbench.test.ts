import { expect, test } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserWorkbench } from "../../src/browserWorkbench/index.js";
import { runBrowserInvocation, type BrowserRunFrame } from "../../src/browser/protocol.js";

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
  });
  const frames = await collect(runBrowserInvocation(request, workbench, { homeDir: await home() }));
  expect(authorized).toMatchObject({ workspaceRoot: "/workspace/forgelet", executionPolicy: "answer_once", trigger: { captureId: "capture_1" } });
  expect(frames.at(-1)).toMatchObject({ type: "page_brief_completed", pageBrief: { summary: "Brief" } });
});

test("Browser Workbench snapshots the requested output language into its Page Brief task", async () => {
  let task = "";
  const workbench = createBrowserWorkbench({ async resolveProfile(id) { return { id, label: "Forgelet", path: "/workspace" }; }, async startLearning(input) { task = input.task; return { status: "completed", summary: "done", pageBrief: { summary: "简明", keyConcepts: "- 概念" } }; } });
  await collect(runBrowserInvocation({ ...request, actionId: "action_lang", invocationId: "invocation_lang", outputLanguage: "zh-CN" }, workbench, { homeDir: await home() }));
  expect(task).toContain("Write all body text in zh-CN");
});

test("Browser Workbench keeps child launches closed until the Page Conversation launcher exists", async () => {
  let launched = false;
  const workbench = createBrowserWorkbench({ async resolveProfile(id) { return { id, label: "Forgelet", path: "/workspace" }; }, async startLearning() { launched = true; return { status: "completed", summary: "unexpected" }; } });
  const { capture: _capture, ...base } = request;
  const frames = await collect(runBrowserInvocation({ ...base, kind: "follow_up" as const, captureId: "capture_1", rootSessionId: "sess_root", parentSessionId: "sess_root", question: "Why?" }, workbench, { homeDir: await home() }));
  expect(launched).toBe(false);
  expect(frames.at(-1)).toMatchObject({ type: "launch_rejected" });
});
