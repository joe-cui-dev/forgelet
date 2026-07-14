import { expect, test } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BROWSER_PROTOCOL_VERSION,
  validateBrowserInvocationRequest,
  runBrowserInvocation,
  type BrowserRunFrame,
  type ProtocolLauncher,
} from "../../src/browser/protocol.js";

const pageBrief = { summary: "A concise page summary.", keyConcepts: "- First concept" };
const rootRequest = {
  version: 3 as const,
  kind: "root" as const,
  conversationId: "conversation_1",
  actionId: "action_1",
  invocationId: "invocation_1",
  workspaceProfileId: "profile_1",
  outputLanguage: "en",
  capture: {
    url: "https://example.com",
    title: "Example",
    content: "A captured page.",
    contentKind: "mainText" as const,
    contentHash: "a".repeat(64),
    contentBytes: 16,
    captureId: "capture_1",
    capturedAt: "2026-07-14T00:00:00.000Z",
    captureReadyMs: 1,
    truncated: false,
  },
};

async function frames(iterable: AsyncIterable<BrowserRunFrame>): Promise<BrowserRunFrame[]> {
  const result: BrowserRunFrame[] = [];
  for await (const frame of iterable) result.push(frame);
  return result;
}

async function homeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-protocol-home-"));
}

test("v3 validates only closed root, root Retry, follow-up, and follow-up Retry request shapes", () => {
  expect(BROWSER_PROTOCOL_VERSION).toBe(3);
  expect(validateBrowserInvocationRequest(rootRequest)).toEqual(rootRequest);
  const { capture: _capture, ...rootRetryBase } = rootRequest;
  expect(validateBrowserInvocationRequest({ ...rootRetryBase, kind: "root_retry", captureId: "capture_1" })).toMatchObject({ kind: "root_retry" });
  const followUp = {
    ...rootRequest,
    kind: "follow_up" as const,
    captureId: "capture_1",
    rootSessionId: "sess_root",
    parentSessionId: "sess_root",
    question: "\nWhat does this mean?\n",
  };
  delete (followUp as { capture?: unknown }).capture;
  expect(validateBrowserInvocationRequest(followUp)).toMatchObject({ kind: "follow_up", question: "What does this mean?" });
  expect(validateBrowserInvocationRequest({ ...followUp, kind: "follow_up_retry" })).toMatchObject({ kind: "follow_up_retry" });
  expect(() => validateBrowserInvocationRequest({ ...rootRequest, workflow: "learning" })).toThrow(/forbidden/i);
});

test("v2 and unknown versions fail with recovery guidance", () => {
  for (const version of [2, 999]) {
    expect(() => validateBrowserInvocationRequest({ ...rootRequest, version })).toThrow(/rebuild.*reload.*install-host/i);
  }
});

test("follow-up questions are non-empty, multiline-capable, and capped at 4 KiB UTF-8", () => {
  const followUp = { ...rootRequest, kind: "follow_up" as const, captureId: "capture_1", rootSessionId: "sess_root", parentSessionId: "sess_root", question: "one\ntwo" };
  delete (followUp as { capture?: unknown }).capture;
  expect(validateBrowserInvocationRequest(followUp)).toMatchObject({ question: "one\ntwo" });
  expect(() => validateBrowserInvocationRequest({ ...followUp, question: "   " })).toThrow(/question/);
  expect(() => validateBrowserInvocationRequest({ ...followUp, question: "é".repeat(3000) })).toThrow(/exceeds/i);
});

test("v3 frames carry conversation and invocation identities with monotonic sequence numbers", async () => {
  const launcher: ProtocolLauncher = {
    async launch({ onLiveEvent }) {
      await onLiveEvent({ type: "session_ready", sessionId: "sess_1", tracePath: "/tmp/sess_1.jsonl" });
      return { status: "completed", summary: "done", pageBrief };
    },
  };
  const result = await frames(runBrowserInvocation(rootRequest, launcher, { homeDir: await homeDir() }));
  expect(result.map((frame) => frame.seq)).toEqual([0, 1, 2]);
  expect(result.every((frame) => frame.conversationId === "conversation_1" && frame.invocationId === "invocation_1")).toBe(true);
  expect(result.at(-1)).toMatchObject({ type: "page_brief_completed", pageBrief });
});

test("Page Answer completion is distinct from Page Brief completion", async () => {
  const request = { ...rootRequest, kind: "follow_up" as const, invocationId: "invocation_2", captureId: "capture_1", rootSessionId: "sess_root", parentSessionId: "sess_root", question: "Why?" };
  delete (request as { capture?: unknown }).capture;
  const launcher: ProtocolLauncher = { async launch() { return { status: "completed", summary: "answer", pageAnswer: { answer: "Because.", groundingStatus: "supported", evidence: ["A captured passage."] } }; } };
  const result = await frames(runBrowserInvocation(request, launcher, { homeDir: await homeDir() }));
  expect(result.at(-1)).toMatchObject({ type: "page_answer_completed", pageAnswer: { answer: "Because." } });
});

test("replaying an invocation returns the persisted terminal Page Brief without a second Session", async () => {
  let launches = 0;
  const launcher: ProtocolLauncher = { async launch() { launches += 1; return { status: "completed", summary: "done", pageBrief }; } };
  const directory = await homeDir();
  await frames(runBrowserInvocation(rootRequest, launcher, { homeDir: directory }));
  const replay = await frames(runBrowserInvocation(rootRequest, launcher, { homeDir: directory }));
  expect(launches).toBe(1);
  expect(replay.at(-1)).toMatchObject({ type: "page_brief_completed", pageBrief });
});

test("an invalid completed launch is persisted and replayed as failed, never as a synthetic Page Brief", async () => {
  const launcher: ProtocolLauncher = {
    async launch() {
      return { status: "completed", summary: "missing normalized outcome" };
    },
  };
  const directory = await homeDir();
  const original = await frames(runBrowserInvocation(rootRequest, launcher, { homeDir: directory }));
  const replay = await frames(runBrowserInvocation(rootRequest, launcher, { homeDir: directory }));
  expect(original.at(-1)).toMatchObject({ type: "failed" });
  expect(replay.at(-1)).toMatchObject({ type: "failed" });
});

test("same invocation with changed conversation, question, or output language is an action conflict", async () => {
  const directory = await homeDir();
  const launcher: ProtocolLauncher = { async launch() { return { status: "completed", summary: "done", pageBrief }; } };
  await frames(runBrowserInvocation(rootRequest, launcher, { homeDir: directory }));
  for (const changed of [{ ...rootRequest, conversationId: "conversation_2" }, { ...rootRequest, outputLanguage: "zh-CN" }]) {
    const result = await frames(runBrowserInvocation(changed, launcher, { homeDir: directory }));
    expect(result.map((frame) => frame.type)).toEqual(["invocation_accepted", "action_conflict"]);
  }
  const { capture: _capture, ...followUpBase } = rootRequest;
  const followUp = { ...followUpBase, kind: "follow_up" as const, invocationId: "invocation_follow_up", captureId: "capture_1", rootSessionId: "sess_root", parentSessionId: "sess_root", question: "Why?" };
  await frames(runBrowserInvocation(followUp, launcher, { homeDir: directory }));
  for (const changed of [{ ...followUp, question: "What changed?" }, { ...followUp, parentSessionId: "sess_other" }]) {
    const result = await frames(runBrowserInvocation(changed, launcher, { homeDir: directory }));
    expect(result.at(-1)).toMatchObject({ type: "action_conflict" });
  }
});
