import {
  createShareCurrentPagePayload,
  extractMainTextFromPage,
  renderShareSummary,
} from "./snapshotProducer.js";

declare const chrome: any;
declare const document: any;
declare const window: any;

const NATIVE_HOST_NAME = "com.forgelet.browser_context";
const SELECTION_CONTEXT_MENU_ID = "forgelet-share-selection";

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

chrome.runtime.onMessage.addListener(
  (message: any, _sender: unknown, sendResponse: (response: unknown) => void) => {
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
  const tab = await getActiveTab();
  if (!tab?.id || !tab.url) throw new Error("No active tab is available.");
  const pageContext = await collectActiveTabPageContext(tab.id);
  const message = createShareCurrentPagePayload({
    mode: "page",
    url: tab.url,
    title: tab.title ?? pageContext.title,
    capturedAt: new Date().toISOString(),
    pageText: extractMainTextFromPage(pageContext),
  });
  return sendSnapshotToNativeHost(message);
}

async function shareSelectedText(
  tab: { url?: string; title?: string },
  selectedText: string,
): Promise<void> {
  if (!tab.url) throw new Error("No tab URL is available.");
  const message = createShareCurrentPagePayload({
    mode: "selection",
    url: tab.url,
    title: tab.title ?? tab.url,
    capturedAt: new Date().toISOString(),
    selectedText,
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
  primaryTextCandidates: string[];
  bodyText: string;
}> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectPageContext,
  });
  return result.result;
}

function collectPageContext(): {
  title: string;
  primaryTextCandidates: string[];
  bodyText: string;
} {
  const selectors = [
    "main",
    "article",
    "[role='main']",
    ".markdown-body",
    ".js-issue-title",
    ".js-comment-body",
    ".documentation",
    ".docs-content",
  ];
  const primaryTextCandidates = selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .map((element: any) => element.innerText ?? element.textContent ?? "");
  return {
    title: document.title || window.location.href,
    primaryTextCandidates,
    bodyText: document.body?.innerText ?? document.body?.textContent ?? "",
  };
}
