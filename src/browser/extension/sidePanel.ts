import type {
  PageConversationAttemptKind,
  PageConversationCurrentAttempt,
  PageConversationProjection,
  PageConversationSuccessfulTurn,
  PageConversationTerminalCard,
} from "./pageConversationProjection.js";
import type { PageConversationNotice } from "./pageConversationController.js";

declare const chrome: any;
declare const document: any;

// ---- Localization: deterministic UI strings only, never a model call. ----

export type SidePanelLanguage = "en" | "zh-CN";

interface SidePanelStrings {
  notFoundEvidence: string;
  historyEvicted: string;
  noConversation: string;
}

const STRINGS: Record<SidePanelLanguage, SidePanelStrings> = {
  en: {
    notFoundEvidence: "No supporting passage found in the captured page.",
    historyEvicted: "Earlier turns remain in the Session Traces on disk.",
    noConversation: "Click the toolbar action to summarize the current page.",
  },
  "zh-CN": {
    notFoundEvidence: "未在已捕获的页面中找到支持性内容。",
    historyEvicted: "更早的对话内容仍保存在磁盘上的 Session Trace 中。",
    noConversation: "点击工具栏按钮以总结当前页面。",
  },
};

export function normalizeSidePanelLanguage(raw: unknown): SidePanelLanguage {
  return raw === "zh-CN" ? "zh-CN" : "en";
}

function localize(language: SidePanelLanguage): SidePanelStrings {
  return STRINGS[language] ?? STRINGS.en;
}

// ---- View model ----

export interface PanelInlineNode {
  kind: "text" | "bold" | "link";
  text: string;
  href?: string;
}

export type PanelBlockNode =
  | { kind: "paragraph"; children: PanelInlineNode[] }
  | { kind: "list_item"; children: PanelInlineNode[] };

export interface SidePanelSourceHeaderView {
  title: string;
  url: string;
  capturedAt: string;
  partial: boolean;
}

export interface SidePanelEvidenceView {
  groundingStatus: "supported" | "not_found";
  excerpts: string[];
  notFoundMessage?: string;
}

export interface SidePanelTurnView {
  kind: "root" | "follow_up";
  question?: string;
  pageBriefSections?: { title: string; blocks: PanelBlockNode[] }[];
  answerBlocks?: PanelBlockNode[];
  evidence?: SidePanelEvidenceView;
}

export interface SidePanelTerminalCardView {
  invocationId: string;
  kind: PageConversationAttemptKind;
  status: PageConversationTerminalCard["status"];
  question?: string;
  reason: string;
  sessionId?: string;
}

export interface SidePanelCurrentAttemptView {
  invocationId: string;
  statusLine: string;
  streamText?: string;
}

export interface SidePanelViewModel {
  hasConversation: boolean;
  source?: SidePanelSourceHeaderView;
  turns: SidePanelTurnView[];
  terminalCards: SidePanelTerminalCardView[];
  currentAttempt?: SidePanelCurrentAttemptView;
  noticeMessage?: string;
  inputEnabled: boolean;
  historyEvictedMessage?: string;
  emptyMessage?: string;
}

export function buildSidePanelViewModel(input: {
  projection: PageConversationProjection | undefined;
  notice?: PageConversationNotice;
  language: SidePanelLanguage;
}): SidePanelViewModel {
  const strings = localize(input.language);
  const { projection } = input;
  if (!projection) {
    return {
      hasConversation: false,
      turns: [],
      terminalCards: [],
      inputEnabled: false,
      ...(input.notice ? { noticeMessage: input.notice.message } : {}),
      emptyMessage: strings.noConversation,
    };
  }

  return {
    hasConversation: true,
    source: {
      title: projection.source.title,
      url: projection.source.url,
      capturedAt: projection.source.capturedAt,
      partial: projection.source.truncated,
    },
    turns: projection.turns.map((turn) => turnView(turn, strings)),
    terminalCards: projection.terminalCards.map(terminalCardView),
    ...(projection.currentAttempt ? { currentAttempt: currentAttemptView(projection.currentAttempt) } : {}),
    ...(input.notice ? { noticeMessage: input.notice.message } : {}),
    // Send is available only once a root Page Brief has succeeded and no
    // attempt is currently in flight (ADR 0050).
    inputEnabled: Boolean(projection.rootSessionId) && !projection.currentAttempt,
    ...(projection.historyEvicted ? { historyEvictedMessage: strings.historyEvicted } : {}),
  };
}

function turnView(turn: PageConversationSuccessfulTurn, strings: SidePanelStrings): SidePanelTurnView {
  if (turn.kind === "root" && turn.pageBrief) {
    return {
      kind: "root",
      pageBriefSections: [
        { title: "Summary", blocks: parsePanelMarkdown(turn.pageBrief.summary) },
        { title: "Key Concepts", blocks: parsePanelMarkdown(turn.pageBrief.keyConcepts) },
      ],
    };
  }
  const answer = turn.pageAnswer;
  return {
    kind: "follow_up",
    ...(turn.question !== undefined ? { question: turn.question } : {}),
    answerBlocks: answer ? parsePanelMarkdown(answer.answer) : [],
    ...(answer
      ? {
          evidence: {
            groundingStatus: answer.groundingStatus,
            excerpts: answer.groundingStatus === "supported" ? answer.evidence : [],
            // The raw protocol sentinel never reaches the panel: not-found
            // always renders this deterministic, localized message instead.
            ...(answer.groundingStatus === "not_found" ? { notFoundMessage: strings.notFoundEvidence } : {}),
          },
        }
      : {}),
  };
}

function terminalCardView(card: PageConversationTerminalCard): SidePanelTerminalCardView {
  return {
    invocationId: card.invocationId,
    kind: card.kind,
    status: card.status,
    ...(card.question !== undefined ? { question: card.question } : {}),
    reason: card.reason,
    ...(card.sessionId !== undefined ? { sessionId: card.sessionId } : {}),
  };
}

function currentAttemptView(attempt: PageConversationCurrentAttempt): SidePanelCurrentAttemptView {
  const parts = [`Status: ${attempt.status}`];
  if (attempt.turnIndex !== undefined) parts.push(`turn ${attempt.turnIndex + 1}`);
  if (attempt.model) parts.push(attempt.model);
  if (attempt.activity) parts.push(attempt.activity);
  return {
    invocationId: attempt.invocationId,
    statusLine: parts.join(" · "),
    ...(attempt.liveText !== undefined ? { streamText: attempt.liveText } : {}),
  };
}

// ---- Follow-up input validation ----

// Mirrors MAX_FOLLOW_UP_QUESTION_BYTES in src/browser/protocol.ts. Not
// imported directly: protocol.ts pulls in node:crypto, which does not exist
// in the MV3 extension bundle.
export const MAX_FOLLOW_UP_QUESTION_BYTES = 4 * 1024;

export type FollowUpQuestionValidation =
  | { ok: true; question: string }
  | { ok: false; message: string };

export function validateFollowUpQuestion(raw: string): FollowUpQuestionValidation {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, message: "Enter a question before sending." };
  if (new TextEncoder().encode(trimmed).byteLength > MAX_FOLLOW_UP_QUESTION_BYTES) {
    return { ok: false, message: `Question is too long (limit ${MAX_FOLLOW_UP_QUESTION_BYTES} UTF-8 bytes).` };
  }
  return { ok: true, question: trimmed };
}

/** Restricted markdown subset for model-authored prose: bold, list items,
 * and http(s) links. Anything else stays literal text — the content derives
 * from external web pages and model output, so no HTML is ever interpreted. */
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

// ---- Rendering: createElement/textContent only, never innerHTML. ----

export interface PanelDocument {
  createElement(tag: string): any;
}

export function renderSidePanelState(
  doc: PanelDocument,
  container: { textContent: string; appendChild(child: any): any },
  view: SidePanelViewModel,
  onRetry?: (invocationId: string) => void,
): { streamElement?: any } {
  container.textContent = "";

  if (view.noticeMessage) {
    const notice = doc.createElement("div");
    notice.setAttribute("class", "notice");
    notice.textContent = view.noticeMessage;
    container.appendChild(notice);
  }

  if (!view.hasConversation) {
    const empty = doc.createElement("p");
    empty.setAttribute("class", "empty");
    empty.textContent = view.emptyMessage ?? "";
    container.appendChild(empty);
    return {};
  }

  if (view.source) {
    const header = doc.createElement("div");
    header.setAttribute("class", "source-header");
    appendText(doc, header, "div", view.source.title, "source-title");
    appendText(doc, header, "div", view.source.url, "source-url");
    appendText(doc, header, "div", view.source.capturedAt, "source-captured-at");
    if (view.source.partial) appendText(doc, header, "span", "Partial capture", "badge-partial");
    container.appendChild(header);
  }

  for (const turn of view.turns) {
    if (turn.kind === "root") {
      for (const section of turn.pageBriefSections ?? []) {
        appendHeading(doc, container, section.title);
        appendBlocks(doc, container, section.blocks);
      }
      continue;
    }
    if (turn.question !== undefined) appendText(doc, container, "p", turn.question, "question");
    appendHeading(doc, container, "Answer");
    appendBlocks(doc, container, turn.answerBlocks ?? []);
    appendHeading(doc, container, "Evidence");
    if (turn.evidence?.groundingStatus === "not_found") {
      appendText(doc, container, "p", turn.evidence.notFoundMessage ?? "", "evidence-not-found");
    } else {
      const list = doc.createElement("ul");
      for (const excerpt of turn.evidence?.excerpts ?? []) {
        const item = doc.createElement("li");
        item.textContent = excerpt;
        list.appendChild(item);
      }
      container.appendChild(list);
    }
  }

  let streamElement: any;
  if (view.currentAttempt) {
    appendText(doc, container, "div", view.currentAttempt.statusLine, "status-line");
    streamElement = doc.createElement("pre");
    streamElement.setAttribute("class", "stream");
    streamElement.textContent = view.currentAttempt.streamText ?? "";
    container.appendChild(streamElement);
  }

  for (const card of view.terminalCards) {
    const wrapper = doc.createElement("div");
    wrapper.setAttribute("class", `terminal-card terminal-card-${card.status}`);
    if (card.question !== undefined) appendText(doc, wrapper, "p", card.question, "question");
    appendText(doc, wrapper, "p", card.reason, "reason");
    if (card.sessionId !== undefined) appendText(doc, wrapper, "p", `Session: ${card.sessionId}`, "session-id");
    const retry = doc.createElement("button");
    retry.setAttribute("type", "button");
    retry.setAttribute("class", "retry");
    retry.textContent = "Retry";
    if (typeof retry.addEventListener === "function") {
      retry.addEventListener("click", () => onRetry?.(card.invocationId));
    }
    wrapper.appendChild(retry);
    container.appendChild(wrapper);
  }

  if (view.historyEvictedMessage) appendText(doc, container, "div", view.historyEvictedMessage, "history-evicted");

  return { streamElement };
}

function appendHeading(doc: PanelDocument, container: { appendChild(child: any): any }, text: string): void {
  const heading = doc.createElement("h2");
  heading.textContent = text;
  container.appendChild(heading);
}

function appendText(
  doc: PanelDocument,
  container: { appendChild(child: any): any },
  tag: string,
  text: string,
  className: string,
): void {
  const element = doc.createElement(tag);
  element.setAttribute("class", className);
  element.textContent = text;
  container.appendChild(element);
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
      link.setAttribute("href", child.href ?? "");
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

// ---- Service Worker messaging ----

export async function requestPageConversationProjection(
  sendMessage: (message: { type: "pageConversationReattach"; windowId: number }) => Promise<unknown>,
  windowId: number,
): Promise<PageConversationProjection | undefined> {
  try {
    const response = await sendMessage({ type: "pageConversationReattach", windowId });
    if (!isRecord(response)) return undefined;
    return response.projection as PageConversationProjection | undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export type PanelFontSizePreference = "small" | "medium" | "large" | "xlarge";

export function normalizeFontSizePreference(raw: unknown): PanelFontSizePreference {
  return raw === "small" || raw === "large" || raw === "xlarge" ? raw : "medium";
}

function normalizeOutputLanguagePreference(raw: unknown): "auto" | "en" | "zh-CN" {
  return raw === "en" || raw === "zh-CN" ? raw : "auto";
}

async function initializeSidePanel(): Promise<void> {
  const output = document.getElementById("workbench-root");
  const stop = document.getElementById("stop");
  const outputLanguage = document.getElementById("output-language");
  const fontSize = document.getElementById("font-size");
  const question = document.getElementById("question");
  const send = document.getElementById("send");
  if (!output || !stop || !outputLanguage || !fontSize || !question || !send) return;

  const windowId: number = (await chrome.windows.getCurrent()).id;

  const storedPreferences = await chrome.storage.local.get([
    "forgeletBrowserWorkbenchOutputLanguage",
    "forgeletBrowserWorkbenchFontSize",
  ]);
  let languagePreference = normalizeOutputLanguagePreference(
    storedPreferences.forgeletBrowserWorkbenchOutputLanguage,
  );
  outputLanguage.value = languagePreference;
  outputLanguage.addEventListener("change", async () => {
    languagePreference = normalizeOutputLanguagePreference(outputLanguage.value);
    outputLanguage.value = languagePreference;
    await chrome.storage.local.set({ forgeletBrowserWorkbenchOutputLanguage: languagePreference });
    // Changing the language only affects the next Send/toolbar gesture's
    // model output language; it never rewrites completed turns, but the
    // panel's own deterministic UI strings must reflect the new choice now.
    render();
  });
  const storedFontSize = normalizeFontSizePreference(storedPreferences.forgeletBrowserWorkbenchFontSize);
  fontSize.value = storedFontSize;
  document.body.setAttribute("data-font-size", storedFontSize);
  fontSize.addEventListener("change", async () => {
    const preference = normalizeFontSizePreference(fontSize.value);
    fontSize.value = preference;
    document.body.setAttribute("data-font-size", preference);
    await chrome.storage.local.set({ forgeletBrowserWorkbenchFontSize: preference });
  });

  let latestProjection: PageConversationProjection | undefined;
  let latestNotice: PageConversationNotice | undefined;
  let streamElement: any;

  const render = (): void => {
    const view = buildSidePanelViewModel({
      projection: latestProjection,
      ...(latestNotice ? { notice: latestNotice } : {}),
      language: normalizeSidePanelLanguage(languagePreference === "zh-CN" ? "zh-CN" : "en"),
    });
    streamElement = renderSidePanelState(document, output, view, (invocationId) => {
      void chrome.runtime.sendMessage({ type: "pageConversationRetry", windowId, invocationId });
    }).streamElement;
    question.disabled = !view.inputEnabled;
    send.disabled = !view.inputEnabled;
  };

  latestProjection = await requestPageConversationProjection(
    (message) => chrome.runtime.sendMessage(message),
    windowId,
  );
  render();

  chrome.runtime.onMessage.addListener((message: any) => {
    if (message?.type === "pageConversationProjection" && message.windowId === windowId) {
      latestProjection = message.projection;
      latestNotice = undefined;
      render();
      return;
    }
    if (message?.type === "pageConversationNotice" && message.windowId === windowId) {
      latestNotice = message.notice;
      render();
      return;
    }
    if (
      message?.type === "pageConversationDelta" &&
      message.windowId === windowId &&
      message.invocationId === latestProjection?.currentAttempt?.invocationId &&
      streamElement
    ) {
      streamElement.textContent += String(message.text ?? "");
    }
  });

  stop.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "pageConversationStop", windowId });
  });

  send.addEventListener("click", async () => {
    const validation = validateFollowUpQuestion(String(question.value ?? ""));
    if (!validation.ok) return;
    question.value = "";
    await chrome.runtime.sendMessage({ type: "pageConversationSend", windowId, question: validation.question });
  });
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  void initializeSidePanel();
}
