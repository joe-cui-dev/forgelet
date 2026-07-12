export type ShareMode = "selection" | "page";

declare const document: any;
declare const window: any;

export type CaptureBlockKind =
  | "heading"
  | "paragraph"
  | "list_item"
  | "code"
  | "link"
  | "table_row"
  | "navigation"
  | "script"
  | "style"
  | "hidden";

export interface CaptureBlock {
  kind: CaptureBlockKind;
  text?: string;
  href?: string;
  cells?: string[];
}

export interface BrowserCapture {
  contentKind: "selectedText" | "mainText";
  content: string;
  contentBytes: number;
  contentHash: string;
  captureId: string;
  capturedAt: string;
  captureReadyMs: number;
}

export interface BrowserCaptureInput {
  capturedAt: string;
  captureId: string;
  captureReadyMs: number;
  selectionText?: string;
  primaryBlocks: CaptureBlock[];
  bodyBlocks: CaptureBlock[];
  primaryRootText?: string;
  limits?: {
    maxBlockBytes?: number;
    maxTotalBytes?: number;
  };
}

export interface ShareCurrentPageInput {
  mode: ShareMode;
  url: string;
  title: string;
  capturedAt: string;
  selectedText?: string;
  pageText?: string;
  capture?: BrowserCapture;
}

export interface ShareCurrentPageMessage {
  type: "shareCurrentPage";
  payload: {
    url: string;
    title: string;
    capturedAt: string;
    captureId?: string;
    captureReadyMs?: number;
    selectedText?: string;
    mainText?: string;
  };
}

export interface PageTextInput {
  primaryTextCandidates: string[];
  bodyText: string;
}

export type ShareSummaryInput =
  | {
      ok: true;
      title: string;
      url: string;
      contentKind: "selectedText" | "mainText";
      contentBytes: number;
      contentHash: string;
      capturedAt: string;
      snapshotPath: string;
    }
  | { ok: false; error: string };

const DEFAULT_MAX_BLOCK_BYTES = 6 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024;

export function isBrowserPageCaptureSupported(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** This function is passed directly to chrome.scripting.executeScript(), so
 * every runtime dependency intentionally remains inside its function body. */
export function collectPageContext(): {
  title: string;
  selectionText: string;
  primaryBlocks: CaptureBlock[];
  bodyBlocks: CaptureBlock[];
  primaryRootText: string;
} {
  const boilerplateSelectors =
    "script,style,nav,header,footer,aside,[role='navigation'],[aria-hidden='true']";
  const isUsefulElement = (element: any): boolean => {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    return !element.closest(boilerplateSelectors);
  };
  const blockFromElement = (element: any): CaptureBlock | undefined => {
    const tagName = String(element.tagName ?? "").toLowerCase();
    const text = element.innerText ?? element.textContent ?? "";
    if (/^h[1-6]$/.test(tagName)) return { kind: "heading", text };
    if (tagName === "li") return { kind: "list_item", text };
    if (tagName === "pre" || tagName === "code") return { kind: "code", text };
    if (tagName === "a") return { kind: "link", text, href: element.href ?? "" };
    if (tagName === "tr") {
      const cells = Array.from(element.querySelectorAll("th,td"))
        .map((cell: any) => cell.innerText ?? cell.textContent ?? "");
      return { kind: "table_row", cells };
    }
    return { kind: "paragraph", text };
  };
  const collectBlocks = (root: any): CaptureBlock[] => {
    if (!root) return [];
    const blockSelectors = "h1,h2,h3,h4,h5,h6,p,li,pre,code,tr,a";
    // An ancestor matching one of these already contributes this element's
    // text through its own innerText, so capturing both would duplicate it
    // (pre>code, inline code, nested li, anything inside a table row).
    const textCapturingAncestors = "p,li,pre,code,h1,h2,h3,h4,h5,h6,tr";
    return Array.from(root.querySelectorAll(blockSelectors))
      .filter((element: any) => isUsefulElement(element))
      .filter((element: any) => !element.parentElement?.closest(textCapturingAncestors))
      .map((element: any) => blockFromElement(element))
      .filter((block: CaptureBlock | undefined): block is CaptureBlock => Boolean(block));
  };
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
  const primaryRoot = selectors
    .map((selector) => document.querySelector(selector))
    .find((element: any) => Boolean(element));
  const collectPrimaryRootText = (): string => {
    const maxBytes = 48 * 1024;
    // Walks the live DOM (a detached clone's innerText degrades to
    // textContent, losing block separators and hidden-element filtering):
    // subtrees without boilerplate contribute their innerText whole,
    // otherwise recurse so nested nav/header/footer/aside drop out.
    const visibleText = (element: any): string => {
      if (!element) return "";
      if (element.matches?.(boilerplateSelectors) || element.hidden) return "";
      if (element.getAttribute?.("aria-hidden") === "true") return "";
      if (!element.querySelector?.(boilerplateSelectors)) {
        return String(element.innerText ?? element.textContent ?? "");
      }
      return Array.from(element.children ?? [])
        .map((child: any) => visibleText(child))
        .filter(Boolean)
        .join("\n");
    };
    const text = visibleText(primaryRoot ?? document.body);
    const encoder = new TextEncoder();
    if (encoder.encode(text).byteLength <= maxBytes) return text;
    let capped = "";
    let usedBytes = 0;
    for (const character of text) {
      const characterBytes = encoder.encode(character).byteLength;
      if (usedBytes + characterBytes > maxBytes) break;
      capped += character;
      usedBytes += characterBytes;
    }
    return capped;
  };
  return {
    title: document.title || window.location.href,
    selectionText: window.getSelection?.()?.toString() ?? "",
    primaryBlocks: collectBlocks(primaryRoot),
    bodyBlocks: collectBlocks(document.body),
    primaryRootText: collectPrimaryRootText(),
  };
}

/**
 * Converts the small DOM-independent block IR collected by the injected page
 * function into a bounded Markdown-like browser attachment.
 */
export async function createBrowserCapture(input: BrowserCaptureInput): Promise<BrowserCapture> {
  const limits = {
    maxBlockBytes: input.limits?.maxBlockBytes ?? DEFAULT_MAX_BLOCK_BYTES,
    maxTotalBytes: input.limits?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };
  const selectedText = normalizePreservingLineBreaks(input.selectionText);
  const contentKind = selectedText ? "selectedText" : "mainText";
  const content = selectedText
    ? truncateUtf8(selectedText, limits.maxTotalBytes)
    : serializeMainText(input, limits);

  return {
    contentKind,
    content,
    contentBytes: utf8ByteLength(content),
    contentHash: await sha256Hex(content),
    captureId: input.captureId,
    capturedAt: input.capturedAt,
    captureReadyMs: input.captureReadyMs,
  };
}

export function renderShareSummary(input: ShareSummaryInput): string {
  if (!input.ok) return `Share failed: ${input.error}`;
  return [
    "Shared with Forgelet",
    `Title: ${input.title}`,
    `URL: ${input.url}`,
    `Content: ${input.contentKind}`,
    `Content bytes: ${input.contentBytes} bytes`,
    `Content hash: ${input.contentHash}`,
    `Captured at: ${input.capturedAt}`,
    `Snapshot: ${input.snapshotPath}`,
    "",
    "Next:",
    "forge browser read-current",
    'forge code --with-browser "<task>"',
  ].join("\n");
}

export function extractMainTextFromPage(input: PageTextInput): string {
  const primaryText = input.primaryTextCandidates
    .map(normalizeText)
    .find((candidate) => candidate.length >= 40);
  return primaryText ?? normalizeText(input.bodyText);
}

export function createShareCurrentPagePayload(
  input: ShareCurrentPageInput,
): ShareCurrentPageMessage {
  const base = {
    url: input.url,
    title: input.title,
    capturedAt: input.capturedAt,
  };
  if (input.capture) {
    const metadata = {
      captureId: input.capture.captureId,
      captureReadyMs: input.capture.captureReadyMs,
    };
    return input.capture.contentKind === "selectedText"
      ? {
          type: "shareCurrentPage",
          payload: { ...base, ...metadata, selectedText: input.capture.content },
        }
      : {
          type: "shareCurrentPage",
          payload: { ...base, ...metadata, mainText: input.capture.content },
        };
  }
  if (input.mode === "selection") {
    return {
      type: "shareCurrentPage",
      payload: {
        ...base,
        selectedText: normalizePreservingLineBreaks(input.selectedText),
      },
    };
  }
  return {
    type: "shareCurrentPage",
    payload: {
      ...base,
      mainText: normalizeText(input.pageText),
    },
  };
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizePreservingLineBreaks(value: string | undefined): string {
  const lines = (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim());
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.reduce<string[]>((result, line) => {
    if (line === "" && result.at(-1) === "") return result;
    result.push(line);
    return result;
  }, []).join("\n");
}

// When the block extractors miss most of the page copy (marketing pages keep
// text in bare <div>s), the structured serialization is a misleadingly thin
// source; fall back to the primary root's normalized innerText instead.
const MAIN_TEXT_COVERAGE_RATIO = 0.6;

function serializeMainText(
  input: BrowserCaptureInput,
  limits: { maxBlockBytes: number; maxTotalBytes: number },
): string {
  const sourceBlocks = input.primaryBlocks.some(isIncludedBlock)
    ? input.primaryBlocks
    : input.bodyBlocks;
  const structured = serializeBlocks(sourceBlocks, limits);
  const rootText = normalizePreservingLineBreaks(input.primaryRootText);
  const coveredEnough =
    utf8ByteLength(structured) >= MAIN_TEXT_COVERAGE_RATIO * utf8ByteLength(rootText);
  return coveredEnough ? structured : truncateUtf8(rootText, limits.maxTotalBytes);
}

function serializeBlocks(
  blocks: CaptureBlock[],
  limits: { maxBlockBytes: number; maxTotalBytes: number },
): string {
  const serialized: string[] = [];
  let totalBytes = 0;
  for (const block of blocks) {
    if (!isIncludedBlock(block)) continue;
    const text = truncateUtf8(serializeBlock(block), limits.maxBlockBytes);
    if (!text) continue;
    const separator = serialized.length === 0 ? "" : "\n\n";
    const remainingBytes = limits.maxTotalBytes - totalBytes - utf8ByteLength(separator);
    if (remainingBytes <= 0) break;
    if (utf8ByteLength(text) > remainingBytes) break;
    serialized.push(text);
    totalBytes += utf8ByteLength(separator) + utf8ByteLength(text);
  }
  return serialized.join("\n\n");
}

function isIncludedBlock(block: CaptureBlock): boolean {
  return !["navigation", "script", "style", "hidden"].includes(block.kind);
}

function serializeBlock(block: CaptureBlock): string {
  const text = block.kind === "code"
    ? normalizeCode(block.text)
    : normalizeText(block.text);
  if (block.kind === "heading") return text ? `# ${text}` : "";
  if (block.kind === "list_item") return text ? `- ${text}` : "";
  if (block.kind === "code") return text ? `\`\`\`\n${text}\n\`\`\`` : "";
  if (block.kind === "link") {
    const href = normalizeText(block.href);
    return text && href ? `[${text}](${href})` : text;
  }
  if (block.kind === "table_row") {
    const cells = (block.cells ?? []).map(normalizeText).filter(Boolean);
    return cells.length > 0 ? `| ${cells.join(" | ")} |` : "";
  }
  return text;
}

function normalizeCode(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
