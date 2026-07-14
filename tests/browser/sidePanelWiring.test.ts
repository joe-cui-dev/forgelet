import { expect, test } from "@jest/globals";

// Drives the actual DOM wiring in initializeSidePanel() (the self-invoking
// init at the bottom of sidePanel.ts), which no existing test touches —
// tests/browser/extension.test.ts only exercises the pure view-model/render
// functions, never the click listeners themselves.

function fakeElement(id: string) {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    id,
    value: "",
    disabled: false,
    attributes: {} as Record<string, string>,
    addEventListener(type: string, listener: () => void) {
      (listeners[type] ??= []).push(listener);
    },
    click() {
      for (const listener of listeners.click ?? []) listener();
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    appendChild() {},
    get textContent() {
      return "";
    },
    set textContent(_v: string) {},
  };
}

test("clicking Send after a successful root Page Brief sends pageConversationSend to the service worker", async () => {
  const elements: Record<string, any> = {
    "workbench-root": fakeElement("workbench-root"),
    stop: fakeElement("stop"),
    "output-language": fakeElement("output-language"),
    "font-size": fakeElement("font-size"),
    question: fakeElement("question"),
    send: fakeElement("send"),
  };

  const sentMessages: any[] = [];
  let onMessageListener: ((message: any) => void) | undefined;

  const fakeChrome = {
    windows: { getCurrent: async () => ({ id: 7 }) },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    runtime: {
      sendMessage: async (message: any) => {
        sentMessages.push(message);
        return { ok: true };
      },
      onMessage: {
        addListener: (listener: (message: any) => void) => {
          onMessageListener = listener;
        },
      },
    },
  };

  const fakeDocument = {
    body: { setAttribute() {} },
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => fakeElement(tag),
  };

  (globalThis as any).document = fakeDocument;
  (globalThis as any).chrome = fakeChrome;

  await import("../../src/browser/extension/sidePanel.js");
  // The module's bottom-of-file guard calls initializeSidePanel() but does
  // not await it before the module finishes loading; give its microtasks a
  // turn to run (chrome.windows.getCurrent(), storage.local.get, reattach).
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(onMessageListener).toBeDefined();

  // Simulate the service worker broadcasting a successful root Page Brief.
  onMessageListener?.({
    type: "pageConversationProjection",
    windowId: 7,
    projection: {
      schemaVersion: 3,
      conversationId: "conv_1",
      captureId: "cap_1",
      workspaceProfileId: "profile_1",
      source: { url: "https://example.com", title: "Example", capturedAt: "2026-07-14T00:00:00.000Z", truncated: false },
      rootSessionId: "sess_root",
      headSessionId: "sess_root",
      turns: [{ invocationId: "inv_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
      terminalCards: [],
      historyEvicted: false,
    },
  });

  expect(elements.send.disabled).toBe(false);
  expect(elements.question.disabled).toBe(false);

  elements.question.value = "What is this page about?";
  elements.send.click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sentMessages).toContainEqual({
    type: "pageConversationSend",
    windowId: 7,
    question: "What is this page about?",
  });
});
