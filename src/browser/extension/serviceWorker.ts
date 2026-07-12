import {
  collectPageContext,
  createBrowserCapture,
  createShareCurrentPagePayload,
  isBrowserPageCaptureSupported,
  renderShareSummary,
  type CaptureBlock,
} from "./snapshotProducer.js";
import {
  createBrowserWorkbenchController,
  type BrowserPanelState,
} from "./workbench.js";

declare const chrome: any;

const NATIVE_HOST_NAME = "com.forgelet.browser_context";
const SELECTION_CONTEXT_MENU_ID = "forgelet-share-selection";
const WORKBENCH_STATES_KEY = "forgeletBrowserWorkbenchStates";
const WORKBENCH_LAST_INVOCATION_KEY = "forgeletBrowserWorkbenchLastInvocation";
let actionWindowId: number | undefined;

const browserWorkbench = createBrowserWorkbenchController({
  bridge: {
    async listProfiles() {
      try {
        const response = await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, {
          type: "listWorkspaceProfiles",
        });
        return Array.isArray(response?.profiles) ? response.profiles : [];
      } catch {
        return [];
      }
    },
    start(input) {
      const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
      port.postMessage({
        type: "browserInvocation",
        request: {
          version: 1,
          actionId: input.actionId,
          invocationId: input.invocationId,
          payload: {
            workspaceProfileId: input.workspaceProfileId,
            ...(input.uiLanguage ? { uiLanguage: input.uiLanguage } : {}),
            capture: input.capture,
          },
        },
      });
      return {
        postMessage: (frame) => port.postMessage(frame),
        onFrame: (listener) => port.onMessage.addListener(listener),
        onDisconnect: (listener) => port.onDisconnect.addListener(listener),
      };
    },
  },
  openSidePanel: async () => {
    if (actionWindowId === undefined) throw new Error("No browser window is available.");
    await chrome.sidePanel.open({ windowId: actionWindowId });
  },
  captureCurrentPage: async () => captureCurrentPageForWorkbench(),
  createId: () => crypto.randomUUID(),
  detectUiLanguage: () => {
    try {
      return chrome.i18n?.getUILanguage?.() ?? (globalThis as any).navigator?.language;
    } catch {
      return undefined;
    }
  },
  persistState: (state) => {
    void chrome.storage.session.get(WORKBENCH_STATES_KEY).then((stored: {
      forgeletBrowserWorkbenchStates?: Record<string, BrowserPanelState>;
    }) =>
      chrome.storage.session.set({
        [WORKBENCH_STATES_KEY]: {
          ...(stored[WORKBENCH_STATES_KEY] ?? {}),
          [state.invocationId]: state,
        },
        [WORKBENCH_LAST_INVOCATION_KEY]: state.invocationId,
      }),
    );
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: "browserWorkbenchState", state }),
    ).catch(() => undefined);
  },
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: SELECTION_CONTEXT_MENU_ID,
    title: "Share selection with Forgelet",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info: any, tab: any) => {
  if (info.menuItemId !== SELECTION_CONTEXT_MENU_ID || !tab) return;
  shareSelectedText(tab, info.selectionText ?? "").catch((error: unknown) => {
    console.error(error);
  });
});

chrome.action.onClicked.addListener((tab: any) => {
  actionWindowId = tab?.windowId;
  browserWorkbench.summarizeCurrentPage().catch((error: unknown) => {
    console.error(error);
  });
});

chrome.runtime.onMessage.addListener(
  (message: any, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (message?.type === "browserWorkbenchReattach") {
      const state = browserWorkbench.reattach(message.invocationId);
      if (state) {
        sendResponse({ state });
        return false;
      }
      chrome.storage.session
        .get([WORKBENCH_STATES_KEY, WORKBENCH_LAST_INVOCATION_KEY])
        .then((stored: {
          forgeletBrowserWorkbenchStates?: Record<string, BrowserPanelState>;
          forgeletBrowserWorkbenchLastInvocation?: string;
        }) => {
          const invocationId = message.invocationId ?? stored[WORKBENCH_LAST_INVOCATION_KEY];
          sendResponse({ state: invocationId ? stored[WORKBENCH_STATES_KEY]?.[invocationId] : undefined });
        });
      return true;
    }
    if (message?.type === "browserWorkbenchStop") {
      browserWorkbench.stop(message.invocationId);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "sharePage") return false;
    shareCurrentPage()
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return true;
  },
);

async function shareCurrentPage(): Promise<{ ok: boolean; summary: string }> {
  const { tab, pageContext, capturedAt, capture } = await captureActiveTab();
  const message = createShareCurrentPagePayload({
    mode: "page",
    url: tab.url,
    title: tab.title ?? pageContext.title,
    capturedAt,
    capture,
  });
  return sendSnapshotToNativeHost(message);
}

async function captureCurrentPageForWorkbench(): Promise<Record<string, unknown>> {
  const { tab, pageContext, capture } = await captureActiveTab();
  return {
    url: tab.url,
    title: tab.title ?? pageContext.title,
    ...capture,
  };
}

async function captureActiveTab(): Promise<{
  tab: { id: number; url: string; title?: string };
  pageContext: Awaited<ReturnType<typeof collectActiveTabPageContext>>;
  capturedAt: string;
  capture: Awaited<ReturnType<typeof createBrowserCapture>>;
}> {
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) throw new Error("No active tab is available.");
  if (!isBrowserPageCaptureSupported(tab.url)) {
    throw new Error("Forgelet can summarize only normal HTTP(S) pages, not Chrome internal pages.");
  }
  const captureStartedAt = Date.now();
  const pageContext = await collectActiveTabPageContext(tab.id);
  const capturedAt = new Date().toISOString();
  const capture = await createBrowserCapture({
    capturedAt,
    captureId: crypto.randomUUID(),
    captureReadyMs: Date.now() - captureStartedAt,
    selectionText: pageContext.selectionText,
    primaryBlocks: pageContext.primaryBlocks,
    bodyBlocks: pageContext.bodyBlocks,
  });
  return { tab, pageContext, capturedAt, capture };
}

async function shareSelectedText(
  tab: { url?: string; title?: string },
  selectedText: string,
): Promise<void> {
  if (!tab.url) throw new Error("No tab URL is available.");
  const capturedAt = new Date().toISOString();
  const capture = await createBrowserCapture({
    capturedAt,
    captureId: crypto.randomUUID(),
    captureReadyMs: 0,
    selectionText: selectedText,
    primaryBlocks: [],
    bodyBlocks: [],
  });
  const message = createShareCurrentPagePayload({
    mode: "selection",
    url: tab.url,
    title: tab.title ?? tab.url,
    capturedAt,
    capture,
  });
  const result = await sendSnapshotToNativeHost(message);
  await chrome.action.setBadgeText({ text: result.ok ? "OK" : "ERR" });
}

async function sendSnapshotToNativeHost(
  message: unknown,
): Promise<{ ok: boolean; summary: string }> {
  const response = await chrome.runtime.sendNativeMessage(
    NATIVE_HOST_NAME,
    message,
  );
  return {
    ok: Boolean(response?.ok),
    summary: renderShareSummary(response),
  };
}

async function getActiveTab(): Promise<any> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function collectActiveTabPageContext(tabId: number): Promise<{
  title: string;
  selectionText: string;
  primaryBlocks: CaptureBlock[];
  bodyBlocks: CaptureBlock[];
}> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageContext,
  });
  const pageContext = result?.result;
  if (!isPageContext(pageContext)) {
    throw new Error("Browser page capture returned no usable document context.");
  }
  return pageContext;
}

function isPageContext(value: unknown): value is {
  title: string;
  selectionText: string;
  primaryBlocks: CaptureBlock[];
  bodyBlocks: CaptureBlock[];
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.title === "string" &&
    typeof record.selectionText === "string" &&
    Array.isArray(record.primaryBlocks) &&
    record.primaryBlocks.every(isCaptureBlock) &&
    Array.isArray(record.bodyBlocks) &&
    record.bodyBlocks.every(isCaptureBlock)
  );
}

function isCaptureBlock(value: unknown): value is CaptureBlock {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as Record<string, unknown>).kind;
  return (
    kind === "heading" ||
    kind === "paragraph" ||
    kind === "list_item" ||
    kind === "code" ||
    kind === "link" ||
    kind === "table_row" ||
    kind === "navigation" ||
    kind === "script" ||
    kind === "style" ||
    kind === "hidden"
  );
}
