import { expect, test } from "@jest/globals";
import {
  createPageConversationController,
  type BrowserWorkbenchPort,
  type PageConversationBridge,
  type PageConversationStartRequest,
} from "../../src/browser/extension/pageConversationController.js";
import type { PageConversationFrame } from "../../src/browser/extension/pageConversationProjection.js";
import type { PageConversationSessionStorage } from "../../src/browser/extension/pageConversationStore.js";

function storage(): PageConversationSessionStorage {
  return { async get() { return {}; }, async set() {} };
}

function controllerHarness(resolveModel: () => string | undefined) {
  const starts: PageConversationStartRequest[] = [];
  const frames = new Map<string, (frame: PageConversationFrame) => void>();
  let id = 0;
  const bridge: PageConversationBridge = {
    async listProfiles() {
      return [{ id: "profile_1", label: "Forgelet", isDefault: true }];
    },
    start(request) {
      starts.push(request);
      const port: BrowserWorkbenchPort = {
        postMessage() {},
        onFrame(listener) {
          frames.set(request.invocationId, listener);
        },
        disconnect() {},
      };
      return port;
    },
    async saveKnowledgeNote() {
      return { ok: false, error: "unused" };
    },
  };
  const controller = createPageConversationController({
    bridge,
    storage: storage(),
    openSidePanel: async () => {},
    captureCurrentPage: async () => ({
      url: "https://example.com",
      title: "Example",
      captureId: "capture_1",
      capturedAt: "2026-08-14T00:00:00.000Z",
      truncated: false,
    }),
    createId: () => `id_${++id}`,
    resolveModel,
  });
  return { starts, frames, controller };
}

test("the model preference is omitted for Default route, forwarded for selected models, and re-resolved by Retry", async () => {
  let selected: string | undefined;
  const h = controllerHarness(() => selected);

  await h.controller.handleToolbarClick(1);
  expect(h.starts[0]).not.toHaveProperty("model");

  selected = "deepseek-v4-flash";
  const rootInvocationId = h.starts[0]!.invocationId;
  h.frames.get(rootInvocationId)!({
    type: "session_ready",
    invocationId: rootInvocationId,
    sessionId: "sess_root",
  });
  h.frames.get(rootInvocationId)!({
    type: "failed",
    invocationId: rootInvocationId,
    message: "temporary failure",
  });
  await h.controller.retry(1, rootInvocationId);
  expect(h.starts.at(-1)).toMatchObject({ kind: "root_retry", model: "deepseek-v4-flash" });

  const pro = controllerHarness(() => "deepseek-v4-pro");
  await pro.controller.handleToolbarClick(2);
  expect(pro.starts[0]).toMatchObject({ kind: "root", model: "deepseek-v4-pro" });
});

function fakeElement(id: string) {
  const listeners: Record<string, (() => void)[]> = {};
  return {
    id,
    value: "",
    checked: false,
    disabled: false,
    attributes: {} as Record<string, string>,
    addEventListener(type: string, listener: () => void) {
      (listeners[type] ??= []).push(listener);
    },
    change() {
      for (const listener of listeners.change ?? []) listener();
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    appendChild() {},
    get textContent() {
      return "";
    },
    set textContent(_value: string) {},
  };
}

test("the Side Panel restores and persists its model preference independently", async () => {
  const elements: Record<string, any> = Object.fromEntries(
    [
      "workbench-root", "stop", "workspace-profile", "model", "output-language", "font-size",
      "debug", "question", "send", "save-note-bar", "note-title", "save-note",
      "save-note-result", "settings-toggle", "panel-settings",
    ].map((id) => [id, fakeElement(id)]),
  );
  const stored: Record<string, unknown> = {
    forgeletBrowserWorkbenchModel: "deepseek-v4-flash",
  };
  const setCalls: Record<string, unknown>[] = [];
  (globalThis as any).document = {
    body: { setAttribute() {} },
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => fakeElement(tag),
  };
  (globalThis as any).chrome = {
    windows: { getCurrent: async () => ({ id: 9 }) },
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]])),
        set: async (items: Record<string, unknown>) => {
          setCalls.push(items);
          Object.assign(stored, items);
        },
      },
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => {} },
    },
  };

  await import("../../src/browser/extension/sidePanel.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(elements.model.value).toBe("deepseek-v4-flash");
  elements.model.value = "deepseek-v4-pro";
  elements.model.change();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(setCalls).toContainEqual({ forgeletBrowserWorkbenchModel: "deepseek-v4-pro" });
});
