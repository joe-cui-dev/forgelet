import { expect, test } from "@jest/globals";

// A separate module registry from sidePanelWiring.test.ts (Jest isolates
// modules per test file, not per test) so this exercises its own fresh
// initializeSidePanel() run with a stored Debug preference already set.

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
    click() {
      for (const listener of listeners.click ?? []) listener();
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
    set textContent(_v: string) {},
  };
}

test("the Debug toggle restores its stored preference and persists changes without touching other preferences", async () => {
  const elements: Record<string, any> = {
    "workbench-root": fakeElement("workbench-root"),
    stop: fakeElement("stop"),
    "output-language": fakeElement("output-language"),
    "font-size": fakeElement("font-size"),
    debug: fakeElement("debug"),
    question: fakeElement("question"),
    send: fakeElement("send"),
  };

  const stored: Record<string, unknown> = { forgeletBrowserWorkbenchDebug: true };
  const setCalls: Record<string, unknown>[] = [];

  const fakeChrome = {
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

  const fakeDocument = {
    body: { setAttribute() {} },
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => fakeElement(tag),
  };

  (globalThis as any).document = fakeDocument;
  (globalThis as any).chrome = fakeChrome;

  await import("../../src/browser/extension/sidePanel.js");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The stored Debug preference is restored into the checkbox on init.
  expect(elements.debug.checked).toBe(true);

  // Unchecking it persists only the Debug key, leaving other preferences untouched.
  elements.debug.checked = false;
  elements.debug.change();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(setCalls).toContainEqual({ forgeletBrowserWorkbenchDebug: false });
  expect(stored.forgeletBrowserWorkbenchOutputLanguage).toBeUndefined();
});
