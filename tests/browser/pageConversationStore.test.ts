import { expect, test } from "@jest/globals";
import {
  clearPageConversationProjection,
  isMeaningfulPageConversationTransition,
  loadPageConversationProjection,
  savePageConversationProjection,
  type PageConversationSessionStorage,
} from "../../src/browser/extension/pageConversationStore.js";
import { createPageConversationProjection, type PageConversationProjection } from "../../src/browser/extension/pageConversationProjection.js";

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

function projection(conversationId: string): PageConversationProjection {
  return createPageConversationProjection({
    conversationId,
    actionId: `${conversationId}_action`,
    invocationId: `${conversationId}_invocation`,
    workspaceProfileId: "profile_1",
    captureId: `${conversationId}_capture`,
    source: { url: "https://example.com", title: "Example", capturedAt: "2026-07-14T00:00:00.000Z", truncated: false },
  });
}

test("different windowId values retain independent projections and reattach without a model call", async () => {
  const storage = fakeStorage();
  await savePageConversationProjection(storage, 1, projection("conversation_a"));
  await savePageConversationProjection(storage, 2, projection("conversation_b"));

  const loadedA = await loadPageConversationProjection(storage, 1);
  const loadedB = await loadPageConversationProjection(storage, 2);

  expect(loadedA?.conversationId).toBe("conversation_a");
  expect(loadedB?.conversationId).toBe("conversation_b");
});

test("a toolbar action in one window does not replace another window's projection", async () => {
  const storage = fakeStorage();
  await savePageConversationProjection(storage, 1, projection("conversation_a"));
  await savePageConversationProjection(storage, 2, projection("conversation_b"));

  await savePageConversationProjection(storage, 1, projection("conversation_a_replaced"));

  expect((await loadPageConversationProjection(storage, 1))?.conversationId).toBe("conversation_a_replaced");
  expect((await loadPageConversationProjection(storage, 2))?.conversationId).toBe("conversation_b");
});

test("a window with no saved projection has nothing to reattach", async () => {
  const storage = fakeStorage();
  expect(await loadPageConversationProjection(storage, 99)).toBeUndefined();
});

test("old or unversioned projection state is discarded rather than reattached", async () => {
  const storage = fakeStorage();
  await storage.set({
    forgeletPageConversationProjectionsByWindow: {
      "1": { schemaVersion: 2, conversationId: "stale" },
      "2": { conversationId: "unversioned" },
    },
  });

  expect(await loadPageConversationProjection(storage, 1)).toBeUndefined();
  expect(await loadPageConversationProjection(storage, 2)).toBeUndefined();
});

test("clearing a window's projection leaves other windows untouched", async () => {
  const storage = fakeStorage();
  await savePageConversationProjection(storage, 1, projection("conversation_a"));
  await savePageConversationProjection(storage, 2, projection("conversation_b"));

  await clearPageConversationProjection(storage, 1);

  expect(await loadPageConversationProjection(storage, 1)).toBeUndefined();
  expect((await loadPageConversationProjection(storage, 2))?.conversationId).toBe("conversation_b");
});

test("a transition is meaningful the first time, and whenever turns, terminal cards, head, eviction, or attempt lifecycle change", () => {
  const base = projection("conversation_a");
  expect(isMeaningfulPageConversationTransition(undefined, base)).toBe(true);

  const withNewTurn: PageConversationProjection = { ...base, turns: [...base.turns, { invocationId: "x", sessionId: "sess_x", kind: "root" }] };
  expect(isMeaningfulPageConversationTransition(base, withNewTurn)).toBe(true);

  const withTerminalCard: PageConversationProjection = { ...base, terminalCards: [{ invocationId: "x", kind: "follow_up", status: "failed", reason: "boom" }] };
  expect(isMeaningfulPageConversationTransition(base, withTerminalCard)).toBe(true);

  const withHead: PageConversationProjection = { ...base, headSessionId: "sess_head" };
  expect(isMeaningfulPageConversationTransition(base, withHead)).toBe(true);

  const withEviction: PageConversationProjection = { ...base, historyEvicted: true };
  expect(isMeaningfulPageConversationTransition(base, withEviction)).toBe(true);

  const attemptStarted: PageConversationProjection = { ...base, currentAttempt: undefined };
  expect(isMeaningfulPageConversationTransition(base, attemptStarted)).toBe(true);

  const runningAttempt: PageConversationProjection = { ...base, currentAttempt: { ...base.currentAttempt!, status: "running", sessionId: "sess_root" } };
  expect(isMeaningfulPageConversationTransition(base, runningAttempt)).toBe(true);
});

test("streamed presentation deltas alone are not a meaningful transition", () => {
  const base = projection("conversation_a");
  const running: PageConversationProjection = { ...base, currentAttempt: { ...base.currentAttempt!, status: "running", sessionId: "sess_root" } };

  const withDelta: PageConversationProjection = {
    ...running,
    currentAttempt: { ...running.currentAttempt!, liveText: "partial", turnIndex: 0, model: "deepseek-chat", activity: "Tool started: read_context" },
  };

  expect(isMeaningfulPageConversationTransition(running, withDelta)).toBe(false);
});
