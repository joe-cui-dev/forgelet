import { expect, test } from "@jest/globals";
import {
  createPageConversationController,
  type BrowserWorkbenchPort,
  type PageConversationBridge,
  type PageConversationNotice,
  type PageConversationStartRequest,
} from "../../src/browser/extension/pageConversationController.js";
import type { PageConversationProjection } from "../../src/browser/extension/pageConversationProjection.js";
import type { PageConversationSessionStorage } from "../../src/browser/extension/pageConversationStore.js";

function fakeStorage(): PageConversationSessionStorage {
  const backing = new Map<string, unknown>();
  return {
    async get(keys) {
      const result: Record<string, unknown> = {};
      for (const key of keys) if (backing.has(key)) result[key] = backing.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) backing.set(key, value);
    },
  };
}

function idFactory(): () => string {
  let count = 0;
  return () => `id_${++count}`;
}

interface PortRecord {
  postMessage: unknown[];
  frame: (frame: Record<string, unknown>) => void;
  disconnected: boolean;
}

interface Harness {
  starts: PageConversationStartRequest[];
  ports: Map<string, PortRecord>;
  openedPanels: number[];
  projections: { windowId: number; projection: PageConversationProjection }[];
  deltas: { windowId: number; invocationId: string; text: string }[];
  notices: { windowId: number; notice: PageConversationNotice }[];
  captureCalls: number;
  captureImpl: () => Promise<Record<string, unknown>>;
  controller: ReturnType<typeof createPageConversationController>;
}

function harness(options: { evictionByteBudget?: number; storage?: PageConversationSessionStorage; resolveDebug?: () => boolean | undefined } = {}): Harness {
  const state: Harness = {
    starts: [],
    ports: new Map<string, PortRecord>(),
    openedPanels: [],
    projections: [],
    deltas: [],
    notices: [],
    captureCalls: 0,
    captureImpl: async () => ({
      url: "https://example.com/docs",
      title: "Docs",
      captureId: "capture_1",
      capturedAt: "2026-07-14T00:00:00.000Z",
      truncated: false,
    }),
    controller: undefined as unknown as ReturnType<typeof createPageConversationController>,
  };
  const bridge: PageConversationBridge = {
    async listProfiles() {
      return [{ id: "profile_default", label: "Forgelet", isDefault: true }];
    },
    start(request) {
      state.starts.push(request);
      const record: PortRecord = { postMessage: [], frame: () => undefined, disconnected: false };
      state.ports.set(request.invocationId, record);
      const port: BrowserWorkbenchPort = {
        postMessage: (frame) => record.postMessage.push(frame),
        onFrame: (listener) => {
          record.frame = listener;
        },
        onDisconnect: () => undefined,
        disconnect: () => {
          record.disconnected = true;
        },
      };
      return port;
    },
  };
  state.controller = createPageConversationController({
    bridge,
    storage: options.storage ?? fakeStorage(),
    openSidePanel: async (windowId) => {
      state.openedPanels.push(windowId);
    },
    captureCurrentPage: async () => {
      state.captureCalls += 1;
      return state.captureImpl();
    },
    createId: idFactory(),
    ...(options.resolveDebug ? { resolveDebug: options.resolveDebug } : {}),
    broadcastProjection: (windowId, projection) => state.projections.push({ windowId, projection }),
    broadcastDelta: (windowId, delta) => state.deltas.push({ windowId, ...delta }),
    broadcastNotice: (windowId, notice) => state.notices.push({ windowId, notice }),
    ...(options.evictionByteBudget !== undefined ? { evictionByteBudget: options.evictionByteBudget } : {}),
  });
  return state;
}

test("an idle toolbar gesture opens the panel, captures the page, and starts a fresh root attempt", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);

  expect(h.openedPanels).toEqual([1]);
  expect(h.captureCalls).toBe(1);
  expect(h.starts).toHaveLength(1);
  expect(h.starts[0]).toMatchObject({ kind: "root", workspaceProfileId: "profile_default" });
  const last = h.projections.at(-1);
  expect(last?.windowId).toBe(1);
  expect(last?.projection.currentAttempt).toMatchObject({ kind: "root", status: "starting" });
});

test("a resolved Debug preference is forwarded on the root start request and omitted when off", async () => {
  const on = harness({ resolveDebug: () => true });
  await on.controller.handleToolbarClick(1);
  expect(on.starts[0]).toMatchObject({ kind: "root", debug: true });

  const off = harness({ resolveDebug: () => false });
  await off.controller.handleToolbarClick(1);
  expect(off.starts[0]).not.toHaveProperty("debug");
});

test("a second toolbar gesture while an attempt runs performs no capture, launch, or implicit Stop", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);
  expect(h.captureCalls).toBe(1);
  expect(h.starts).toHaveLength(1);

  await h.controller.handleToolbarClick(1);

  expect(h.captureCalls).toBe(1);
  expect(h.starts).toHaveLength(1);
  expect(h.openedPanels).toEqual([1, 1]);
  expect(h.notices.at(-1)).toMatchObject({ windowId: 1, notice: { kind: "attempt_in_progress" } });
  // No cancel was posted to the running attempt's port.
  const port = h.ports.get(h.starts[0]!.invocationId)!;
  expect(port.postMessage).toEqual([]);
});

test("a toolbar gesture after terminal state starts a new capture and conversation, switching only that window", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);
  const firstInvocationId = h.starts[0]!.invocationId;
  const port = h.ports.get(firstInvocationId)!;
  port.frame({ type: "session_ready", invocationId: firstInvocationId, sessionId: "sess_1", tracePath: "/tmp/sess_1.jsonl" });
  port.frame({ type: "page_brief_completed", invocationId: firstInvocationId, pageBrief: { summary: "S", keyConcepts: "- K" } });

  const firstConversationId = h.projections.at(-1)!.projection.conversationId;

  await h.controller.handleToolbarClick(1);

  expect(h.captureCalls).toBe(2);
  expect(h.starts).toHaveLength(2);
  const secondConversationId = h.projections.at(-1)!.projection.conversationId;
  expect(secondConversationId).not.toBe(firstConversationId);
  expect(h.projections.at(-1)!.projection.turns).toEqual([]);
});

test("different windows launch and run concurrently without interfering with each other", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);
  await h.controller.handleToolbarClick(2);

  expect(h.starts).toHaveLength(2);
  const invocationForWindow1 = h.projections.find((entry) => entry.windowId === 1)!.projection.currentAttempt!.invocationId;
  const invocationForWindow2 = h.projections.find((entry) => entry.windowId === 2)!.projection.currentAttempt!.invocationId;
  expect(invocationForWindow1).not.toBe(invocationForWindow2);

  const portA = h.ports.get(invocationForWindow1)!;
  portA.frame({ type: "session_ready", invocationId: invocationForWindow1, sessionId: "sess_a" });
  portA.frame({ type: "page_brief_completed", invocationId: invocationForWindow1, pageBrief: { summary: "A", keyConcepts: "- K" } });

  const window2Projection = (await h.controller.reattach(2))!;
  expect(window2Projection.currentAttempt).toMatchObject({ status: "starting" });
  expect(window2Projection.turns).toEqual([]);
});

test("a terminal frame releases its Native Port", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);
  const invocationId = h.starts[0]!.invocationId;
  const port = h.ports.get(invocationId)!;

  port.frame({ type: "session_ready", invocationId, sessionId: "sess_1" });
  expect(port.disconnected).toBe(false);
  port.frame({ type: "page_brief_completed", invocationId, pageBrief: { summary: "S", keyConcepts: "- K" } });

  expect(port.disconnected).toBe(true);
});

test("Stop targets only the active attempt and is idempotent", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);
  const invocationId = h.starts[0]!.invocationId;
  const port = h.ports.get(invocationId)!;

  h.controller.stop(1);
  h.controller.stop(1);

  expect(port.postMessage).toEqual([{ type: "cancel", invocationId }]);
  expect((await h.controller.reattach(1))?.currentAttempt?.status).toBe("stopping");
});

test("Send starts a follow-up from the current head and Retry starts a fresh attempt from a terminal card", async () => {
  const h = harness();
  await h.controller.handleToolbarClick(1);
  const rootInvocationId = h.starts[0]!.invocationId;
  const rootPort = h.ports.get(rootInvocationId)!;
  rootPort.frame({ type: "session_ready", invocationId: rootInvocationId, sessionId: "sess_root" });
  rootPort.frame({ type: "page_brief_completed", invocationId: rootInvocationId, pageBrief: { summary: "S", keyConcepts: "- K" } });

  await h.controller.sendFollowUp(1, "Why?");
  expect(h.starts.at(-1)).toMatchObject({ kind: "follow_up", rootSessionId: "sess_root", parentSessionId: "sess_root", question: "Why?" });
  const followUpInvocationId = h.starts.at(-1)!.invocationId;
  const followUpPort = h.ports.get(followUpInvocationId)!;
  followUpPort.frame({ type: "session_ready", invocationId: followUpInvocationId, sessionId: "sess_f1" });
  followUpPort.frame({ type: "failed", invocationId: followUpInvocationId, message: "model unavailable" });

  const beforeRetry = (await h.controller.reattach(1))!;
  expect(beforeRetry.terminalCards).toHaveLength(1);
  expect(beforeRetry.headSessionId).toBe("sess_root");

  await h.controller.retry(1, followUpInvocationId);
  expect(h.starts.at(-1)).toMatchObject({ kind: "follow_up_retry", rootSessionId: "sess_root", parentSessionId: "sess_root", question: "Why?" });
  const afterRetry = (await h.controller.reattach(1))!;
  expect(afterRetry.currentAttempt).toMatchObject({ kind: "follow_up_retry", question: "Why?" });
});

test("Send restores the stored conversation after a service worker restart", async () => {
  const storage = fakeStorage();
  const initial = harness({ storage });
  await initial.controller.handleToolbarClick(1);
  const rootInvocationId = initial.starts[0]!.invocationId;
  const rootPort = initial.ports.get(rootInvocationId)!;
  rootPort.frame({ type: "session_ready", invocationId: rootInvocationId, sessionId: "sess_root" });
  rootPort.frame({ type: "page_brief_completed", invocationId: rootInvocationId, pageBrief: { summary: "S", keyConcepts: "- K" } });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The Side Panel retains its projection, but an MV3 service worker can be
  // restarted between two clicks. Send must recover the stored conversation.
  const restarted = harness({ storage });
  await restarted.controller.sendFollowUp(1, "What should I ask next?");

  expect(restarted.starts).toHaveLength(1);
  expect(restarted.starts[0]).toMatchObject({
    kind: "follow_up",
    rootSessionId: "sess_root",
    parentSessionId: "sess_root",
  });
});

test("an unsupported page reports a capture-unavailable notice without starting an attempt", async () => {
  const h = harness();
  h.captureImpl = async () => {
    throw new Error("Forgelet can summarize only normal HTTP(S) pages, not Chrome internal pages.");
  };

  await h.controller.handleToolbarClick(1);

  expect(h.starts).toEqual([]);
  expect(h.notices.at(-1)).toMatchObject({
    windowId: 1,
    notice: { kind: "capture_unavailable", message: expect.stringContaining("Chrome internal pages") },
  });
});

test("eviction is actually applied to the saved and broadcast projection, not just available as an unused pure function", async () => {
  const h = harness({ evictionByteBudget: 900 });
  await h.controller.handleToolbarClick(1);
  const rootInvocationId = h.starts[0]!.invocationId;
  const rootPort = h.ports.get(rootInvocationId)!;
  rootPort.frame({ type: "session_ready", invocationId: rootInvocationId, sessionId: "sess_root" });
  rootPort.frame({ type: "page_brief_completed", invocationId: rootInvocationId, pageBrief: { summary: "S", keyConcepts: "- K" } });

  for (let index = 0; index < 6; index += 1) {
    await h.controller.sendFollowUp(1, `Question number ${index} with enough padding text to matter for byte counting.`);
    const invocationId = h.starts.at(-1)!.invocationId;
    const port = h.ports.get(invocationId)!;
    port.frame({ type: "session_ready", invocationId, sessionId: `sess_${index}` });
    port.frame({
      type: "page_answer_completed",
      invocationId,
      pageAnswer: { answer: `Answer number ${index} with some descriptive padding text as well.`, groundingStatus: "supported", evidence: ["A captured passage with enough padding to add real bytes."] },
    });
  }

  const projection = (await h.controller.reattach(1))!;
  expect(projection.historyEvicted).toBe(true);
  // Root Page Brief and the current head are always preserved.
  expect(projection.turns[0]?.kind).toBe("root");
  expect(projection.turns.at(-1)?.sessionId).toBe(projection.headSessionId);
  expect(projection.turns.length).toBeLessThan(7);
  // The broadcast the panel actually renders is the bounded projection too.
  expect(h.projections.at(-1)?.projection.historyEvicted).toBe(true);
});
