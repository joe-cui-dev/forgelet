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

async function makeHomeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-protocol-home-"));
}

async function collectFrames(
  frames: AsyncIterable<BrowserRunFrame>,
): Promise<BrowserRunFrame[]> {
  const collected: BrowserRunFrame[] = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
}

const baseRequest = {
  version: BROWSER_PROTOCOL_VERSION,
  actionId: "summarizeCurrentPage",
  invocationId: "inv_1",
  payload: { url: "https://example.com" },
};

test("validateBrowserInvocationRequest accepts a well-formed invocation request", () => {
  const request = validateBrowserInvocationRequest({
    version: BROWSER_PROTOCOL_VERSION,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payload: { url: "https://example.com" },
  });

  expect(request).toEqual({
    version: BROWSER_PROTOCOL_VERSION,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payload: { url: "https://example.com" },
  });
});

test("validateBrowserInvocationRequest fails closed on an unknown protocol version", () => {
  expect(() =>
    validateBrowserInvocationRequest({
      version: 999,
      actionId: "summarizeCurrentPage",
      invocationId: "inv_1",
      payload: {},
    }),
  ).toThrow(/unsupported.*version/i);
});

test("validateBrowserInvocationRequest fails closed on a malformed request", () => {
  expect(() => validateBrowserInvocationRequest(null)).toThrow(/malformed|object/i);
  expect(() =>
    validateBrowserInvocationRequest({
      version: BROWSER_PROTOCOL_VERSION,
      invocationId: "inv_1",
      payload: {},
    }),
  ).toThrow(/actionId/);
  expect(() =>
    validateBrowserInvocationRequest({
      version: BROWSER_PROTOCOL_VERSION,
      actionId: "summarizeCurrentPage",
      invocationId: "inv_1",
      payload: "not-an-object",
    }),
  ).toThrow(/payload/);
});

test("validateBrowserInvocationRequest fails closed on an oversized payload", () => {
  expect(() =>
    validateBrowserInvocationRequest({
      version: BROWSER_PROTOCOL_VERSION,
      actionId: "summarizeCurrentPage",
      invocationId: "inv_1",
      payload: { text: "x".repeat(200_000) },
    }),
  ).toThrow(/exceeds|oversized/i);
});

test("a valid invocation produces strictly increasing sequence numbers and legal state transitions", async () => {
  const homeDir = await makeHomeDir();
  const launcher: ProtocolLauncher = {
    async launch({ onLiveEvent }) {
      await onLiveEvent({
        type: "session_ready",
        sessionId: "sess_1",
        tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
      });
      await onLiveEvent({
        type: "model_turn_started",
        turnIndex: 0,
        model: "deepseek-v4-flash",
      });
      await onLiveEvent({
        type: "model_turn_finished",
        turnIndex: 0,
        model: "deepseek-v4-flash",
        toolCallCount: 0,
      });
      return { status: "completed", summary: "Forgelet session completed: sess_1" };
    },
  };

  const frames = await collectFrames(runBrowserInvocation(baseRequest, launcher, { homeDir }));

  expect(frames.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4]);
  expect(frames.every((frame) => frame.invocationId === "inv_1")).toBe(true);
  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "session_ready",
    "live_event",
    "live_event",
    "completed",
  ]);
});

test("a preflight failure ends with exactly one launch_rejected frame and no Session identity", async () => {
  const homeDir = await makeHomeDir();
  const launcher: ProtocolLauncher = {
    async launch() {
      throw new Error("Workspace Profile is revoked: profile_x");
    },
  };

  const frames = await collectFrames(runBrowserInvocation(baseRequest, launcher, { homeDir }));

  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "launch_rejected",
  ]);
  expect(frames.some((frame) => "sessionId" in frame)).toBe(false);
  const rejected = frames.find((frame) => frame.type === "launch_rejected");
  expect(rejected).toMatchObject({ reason: expect.stringContaining("revoked") });
});

test("a ready run emits identity before live model events and exactly one terminal frame", async () => {
  const homeDir = await makeHomeDir();
  const launcher: ProtocolLauncher = {
    async launch({ onLiveEvent }) {
      await onLiveEvent({
        type: "session_ready",
        sessionId: "sess_1",
        tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
      });
      await onLiveEvent({
        type: "model_turn_started",
        turnIndex: 0,
        model: "deepseek-v4-flash",
      });
      return { status: "completed", summary: "Forgelet session completed: sess_1" };
    },
  };

  const frames = await collectFrames(runBrowserInvocation(baseRequest, launcher, { homeDir }));

  const readyIndex = frames.findIndex((frame) => frame.type === "session_ready");
  const firstLiveEventIndex = frames.findIndex((frame) => frame.type === "live_event");
  expect(readyIndex).toBeGreaterThanOrEqual(0);
  expect(readyIndex).toBeLessThan(firstLiveEventIndex);

  const terminalFrames = frames.filter((frame) =>
    ["completed", "stopped", "failed"].includes(frame.type),
  );
  expect(terminalFrames).toHaveLength(1);
});

test("the same invocation identity with the same payload never starts a second Session and replays terminal state", async () => {
  const homeDir = await makeHomeDir();
  const pack = {
    summary: "A concise page summary.",
    keyConcepts: "- First concept",
    sourceLinks: "- browser: Example Docs",
    openQuestions: "- None",
    reviewPrompts: "- Recall the first concept",
  };
  let launchCount = 0;
  const launcher: ProtocolLauncher = {
    async launch({ onLiveEvent }) {
      launchCount += 1;
      await onLiveEvent({
        type: "session_ready",
        sessionId: "sess_1",
        tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
      });
      return {
        status: "completed",
        summary: "Forgelet session completed: sess_1",
        learningPack: pack,
      };
    },
  };

  const first = await collectFrames(runBrowserInvocation(baseRequest, launcher, { homeDir }));
  const second = await collectFrames(runBrowserInvocation(baseRequest, launcher, { homeDir }));

  expect(launchCount).toBe(1);
  expect(first.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "session_ready",
    "completed",
  ]);
  expect(second.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "session_ready",
    "completed",
  ]);
  const secondReady = second.find((frame) => frame.type === "session_ready");
  expect(secondReady).toMatchObject({ sessionId: "sess_1" });
  // The replayed terminal frame carries the persisted Learning Pack, so the
  // panel renders the same styled sections as the original run.
  const secondCompleted = second.find((frame) => frame.type === "completed");
  expect(secondCompleted).toMatchObject({
    summary: "Forgelet session completed: sess_1",
    learningPack: pack,
  });
});

test("the same invocation identity with a different payload returns action_conflict", async () => {
  const homeDir = await makeHomeDir();
  let launchCount = 0;
  const launcher: ProtocolLauncher = {
    async launch({ onLiveEvent }) {
      launchCount += 1;
      await onLiveEvent({
        type: "session_ready",
        sessionId: "sess_1",
        tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
      });
      return { status: "completed", summary: "done" };
    },
  };
  const requestB = { ...baseRequest, payload: { url: "https://different.example.com" } };

  await collectFrames(runBrowserInvocation(baseRequest, launcher, { homeDir }));
  const conflictFrames = await collectFrames(runBrowserInvocation(requestB, launcher, { homeDir }));

  expect(launchCount).toBe(1);
  expect(conflictFrames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "action_conflict",
  ]);
});

test("cancel before ready follows WP4 semantics: launch_rejected with no Session identity", async () => {
  const homeDir = await makeHomeDir();
  const controller = new AbortController();
  controller.abort();
  const launcher: ProtocolLauncher = {
    async launch({ signal }) {
      if (signal?.aborted)
        throw new Error("Session launch cancelled before Session creation.");
      return { status: "completed", summary: "unused" };
    },
  };

  const frames = await collectFrames(
    runBrowserInvocation(baseRequest, launcher, { homeDir, signal: controller.signal }),
  );

  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "launch_rejected",
  ]);
});

test("cancel after ready follows WP4 semantics: stopped/user_stopped with Trace evidence", async () => {
  const homeDir = await makeHomeDir();
  const controller = new AbortController();
  const launcher: ProtocolLauncher = {
    async launch({ onLiveEvent }) {
      await onLiveEvent({
        type: "session_ready",
        sessionId: "sess_1",
        tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
      });
      controller.abort();
      return { status: "stopped", reason: "user_stopped" };
    },
  };

  const frames = await collectFrames(
    runBrowserInvocation(baseRequest, launcher, { homeDir, signal: controller.signal }),
  );

  expect(frames.map((frame) => frame.type)).toEqual([
    "invocation_accepted",
    "session_ready",
    "stopped",
  ]);
  const stopped = frames.find((frame) => frame.type === "stopped");
  expect(stopped).toMatchObject({ reason: "user_stopped" });
});
