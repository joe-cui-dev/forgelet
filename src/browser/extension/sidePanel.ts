import type { BrowserPanelState } from "./workbench.js";

declare const chrome: any;
declare const document: any;

export type PanelInlineNode =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "link"; text: string; href: string };

export type PanelBlockNode =
  | { kind: "paragraph"; children: PanelInlineNode[] }
  | { kind: "list_item"; children: PanelInlineNode[] };

export interface PanelPackSection {
  title: string;
  blocks: PanelBlockNode[];
}

export interface SidePanelViewModel {
  statusLine: string;
  streamText?: string;
  packSections?: PanelPackSection[];
  messageText?: string;
  profiles?: string[];
  rawSummary?: string;
}

const STREAMING_STATUSES: BrowserPanelState["status"][] = [
  "starting",
  "running",
  "stopping",
];

export function buildSidePanelViewModel(
  state: BrowserPanelState | undefined,
): SidePanelViewModel {
  if (!state) {
    return { statusLine: "No Browser Workbench invocation is attached." };
  }
  const view: SidePanelViewModel = { statusLine: statusLineFor(state) };
  if (STREAMING_STATUSES.includes(state.status)) {
    view.streamText = state.liveText ?? "";
  }
  if (state.status === "completed") {
    if (state.pageBrief) {
      view.packSections = [
        { title: "Summary", blocks: parsePanelMarkdown(state.pageBrief.summary) },
        { title: "Key Concepts", blocks: parsePanelMarkdown(state.pageBrief.keyConcepts) },
      ];
      if (state.summary) view.rawSummary = state.summary;
    } else if (state.learningPack) {
      view.packSections = [
        { title: "Summary", blocks: parsePanelMarkdown(state.learningPack.summary) },
        { title: "Key Concepts", blocks: parsePanelMarkdown(state.learningPack.keyConcepts) },
        { title: "Source Links", blocks: parsePanelMarkdown(state.learningPack.sourceLinks) },
        { title: "Open Questions", blocks: parsePanelMarkdown(state.learningPack.openQuestions) },
        { title: "Review Prompts", blocks: parsePanelMarkdown(state.learningPack.reviewPrompts) },
      ];
      // The raw summary blob (including its Trace/Session lines) is available
      // whole inside a collapsed details block; the panel renders nothing
      // else from it, which is what de-duplicates those lines.
      if (state.summary) view.rawSummary = state.summary;
    } else if (state.summary) {
      view.messageText = state.summary;
    }
  } else if (state.message) {
    view.messageText = state.message;
  }
  if (state.status === "needs_profile" && state.profiles && state.profiles.length > 0) {
    view.profiles = state.profiles.map(
      (profile) => `${profile.isDefault ? "* " : ""}${profile.label} (${profile.id})`,
    );
  }
  return view;
}

function statusLineFor(state: BrowserPanelState): string {
  const parts = [`Status: ${state.status}`];
  if (STREAMING_STATUSES.includes(state.status)) {
    if (state.turnIndex !== undefined) parts.push(`turn ${state.turnIndex + 1}`);
    if (state.model) parts.push(state.model);
    if (state.activity) parts.push(state.activity);
  }
  return parts.join(" · ");
}

/** Restricted markdown subset for Learning Pack section bodies: bold, list
 * items, and http(s) links. Anything else stays literal text — the content
 * derives from external web pages, so no HTML is ever interpreted. */
export function parsePanelMarkdown(body: string): PanelBlockNode[] {
  const blocks: PanelBlockNode[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("- ")) {
      blocks.push({ kind: "list_item", children: parseInline(line.slice(2)) });
    } else {
      blocks.push({ kind: "paragraph", children: parseInline(line) });
    }
  }
  return blocks;
}

function parseInline(text: string): PanelInlineNode[] {
  const nodes: PanelInlineNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push({ kind: "text", text: text.slice(lastIndex, index) });
    if (match[1] !== undefined) {
      nodes.push({ kind: "bold", text: match[1] });
    } else if (/^https?:\/\//.test(match[3] ?? "")) {
      nodes.push({ kind: "link", text: match[2] ?? "", href: match[3] ?? "" });
    } else {
      nodes.push({ kind: "text", text: match[0] });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) nodes.push({ kind: "text", text: text.slice(lastIndex) });
  return nodes;
}

export interface PanelDocument {
  createElement(tag: string): any;
}

/** Maps the view model to DOM using only createElement/textContent; the
 * content comes from external pages and model output, so innerHTML is never
 * used anywhere in the panel. */
export function renderSidePanelState(
  doc: PanelDocument,
  container: { textContent: string; appendChild(child: any): any },
  state: BrowserPanelState | undefined,
): { streamElement?: any } {
  const view = buildSidePanelViewModel(state);
  container.textContent = "";

  const statusLine = doc.createElement("div");
  statusLine.setAttribute("class", "status-line");
  statusLine.textContent = view.statusLine;
  container.appendChild(statusLine);

  let streamElement: any;
  if (view.streamText !== undefined) {
    streamElement = doc.createElement("pre");
    streamElement.setAttribute("class", "stream");
    streamElement.textContent = view.streamText;
    container.appendChild(streamElement);
  }

  for (const section of view.packSections ?? []) {
    const heading = doc.createElement("h2");
    heading.textContent = section.title;
    container.appendChild(heading);
    appendBlocks(doc, container, section.blocks);
  }

  if (view.messageText !== undefined) {
    const message = doc.createElement("pre");
    message.setAttribute("class", "message");
    message.textContent = view.messageText;
    container.appendChild(message);
  }

  if (view.profiles) {
    const list = doc.createElement("ul");
    for (const profile of view.profiles) {
      const item = doc.createElement("li");
      item.textContent = profile;
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  if (view.rawSummary !== undefined) {
    const details = doc.createElement("details");
    const summaryToggle = doc.createElement("summary");
    summaryToggle.textContent = "Raw session summary";
    details.appendChild(summaryToggle);
    const raw = doc.createElement("pre");
    raw.textContent = view.rawSummary;
    details.appendChild(raw);
    container.appendChild(details);
  }

  return { streamElement };
}

export async function requestBrowserWorkbenchState(
  sendMessage: (message: { type: "browserWorkbenchReattach" }) => Promise<unknown>,
): Promise<BrowserPanelState | undefined> {
  try {
    const response = await sendMessage({ type: "browserWorkbenchReattach" });
    if (!isRecord(response)) return undefined;
    return response.state as BrowserPanelState | undefined;
  } catch {
    return undefined;
  }
}

function appendBlocks(
  doc: PanelDocument,
  container: { appendChild(child: any): any },
  blocks: PanelBlockNode[],
): void {
  let openList: any;
  for (const block of blocks) {
    if (block.kind === "list_item") {
      if (!openList) {
        openList = doc.createElement("ul");
        container.appendChild(openList);
      }
      openList.appendChild(inlineElement(doc, "li", block.children));
    } else {
      openList = undefined;
      container.appendChild(inlineElement(doc, "p", block.children));
    }
  }
}

function inlineElement(doc: PanelDocument, tag: string, children: PanelInlineNode[]): any {
  const element = doc.createElement(tag);
  for (const child of children) {
    if (child.kind === "bold") {
      const bold = doc.createElement("strong");
      bold.textContent = child.text;
      element.appendChild(bold);
    } else if (child.kind === "link") {
      const link = doc.createElement("a");
      link.setAttribute("href", child.href);
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
      link.textContent = child.text;
      element.appendChild(link);
    } else {
      const text = doc.createElement("span");
      text.textContent = child.text;
      element.appendChild(text);
    }
  }
  return element;
}

async function initializeSidePanel(): Promise<void> {
  const output = document.getElementById("workbench-root");
  const stop = document.getElementById("stop");
  const outputLanguage = document.getElementById("output-language");
  const fontSize = document.getElementById("font-size");
  if (!output || !stop || !outputLanguage || !fontSize) return;
  const storedPreferences = await chrome.storage.local.get([
    "forgeletBrowserWorkbenchOutputLanguage",
    "forgeletBrowserWorkbenchFontSize",
  ]);
  outputLanguage.value = normalizeOutputLanguagePreference(
    storedPreferences.forgeletBrowserWorkbenchOutputLanguage,
  );
  outputLanguage.addEventListener("change", async () => {
    const preference = normalizeOutputLanguagePreference(outputLanguage.value);
    outputLanguage.value = preference;
    await chrome.storage.local.set({ forgeletBrowserWorkbenchOutputLanguage: preference });
  });
  const storedFontSize = normalizeFontSizePreference(
    storedPreferences.forgeletBrowserWorkbenchFontSize,
  );
  fontSize.value = storedFontSize;
  document.body.setAttribute("data-font-size", storedFontSize);
  fontSize.addEventListener("change", async () => {
    const preference = normalizeFontSizePreference(fontSize.value);
    fontSize.value = preference;
    document.body.setAttribute("data-font-size", preference);
    await chrome.storage.local.set({ forgeletBrowserWorkbenchFontSize: preference });
  });
  let currentInvocationId: string | undefined;
  let streamElement: any;
  const render = (state: BrowserPanelState | undefined): void => {
    currentInvocationId = state?.invocationId;
    streamElement = renderSidePanelState(document, output, state).streamElement;
  };
  render(
    await requestBrowserWorkbenchState((message) => chrome.runtime.sendMessage(message)),
  );
  chrome.runtime.onMessage.addListener((message: any) => {
    if (message?.type === "browserWorkbenchState") render(message.state);
    if (
      message?.type === "browserWorkbenchDelta" &&
      message.invocationId === currentInvocationId &&
      streamElement
    ) {
      streamElement.textContent += String(message.text ?? "");
    }
  });
  stop.addEventListener("click", async () => {
    const state = await requestBrowserWorkbenchState((message) => chrome.runtime.sendMessage(message));
    if (state?.invocationId) {
      try {
        await chrome.runtime.sendMessage({
          type: "browserWorkbenchStop",
          invocationId: state.invocationId,
        });
      } catch {
        render({
          ...state,
          status: "failed",
          message: "Unable to contact the Forgelet Service Worker. Reload the extension and reopen the Side Panel.",
        });
      }
    }
  });
}

function normalizeOutputLanguagePreference(raw: unknown): "auto" | "en" | "zh-CN" {
  return raw === "en" || raw === "zh-CN" ? raw : "auto";
}

export type PanelFontSizePreference = "small" | "medium" | "large" | "xlarge";

export function normalizeFontSizePreference(raw: unknown): PanelFontSizePreference {
  return raw === "small" || raw === "large" || raw === "xlarge" ? raw : "medium";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initializeSidePanel();
}
