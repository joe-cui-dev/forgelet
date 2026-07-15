import { expect, test } from "@jest/globals";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectPageContext,
  createBrowserCapture,
  createShareCurrentPagePayload,
  extractMainTextFromPage,
  isBrowserPageCaptureSupported,
  renderShareSummary,
} from "../../src/browser/extension/snapshotProducer.js";
import {
  browserExtensionManifest,
  buildBrowserExtension,
} from "../../src/browser/extension/buildExtension.js";
import { normalizeBrowserOutputLanguage } from "../../src/browser/extension/pageConversationController.js";
import {
  buildSidePanelViewModel,
  normalizeFontSizePreference,
  normalizeSidePanelLanguage,
  parsePanelMarkdown,
  renderSidePanelState,
  requestPageConversationProjection,
  validateFollowUpQuestion,
} from "../../src/browser/extension/sidePanel.js";
import { createPageConversationProjection, type PageConversationProjection } from "../../src/browser/extension/pageConversationProjection.js";
import { sidePanelHtml } from "../../src/browser/extension/buildExtension.js";

test("browser extension selected-text share builds a minimal snapshot payload", () => {
  const payload = createShareCurrentPagePayload({
    mode: "selection",
    url: "https://example.com/issue/123",
    title: "Fix checkout bug",
    capturedAt: "2026-07-02T00:00:00.000Z",
    selectedText: "The checkout button throws after payment auth.",
    pageText: "Full page text should not be sent for selected-text sharing.",
  });

  expect(payload).toEqual({
    type: "shareCurrentPage",
    payload: {
      url: "https://example.com/issue/123",
      title: "Fix checkout bug",
      capturedAt: "2026-07-02T00:00:00.000Z",
      selectedText: "The checkout button throws after payment auth.",
    },
  });
});

test("browser extension whole-page share prefers primary content text", () => {
  const mainText = extractMainTextFromPage({
    primaryTextCandidates: [
      "Navigation",
      "Install the SDK before creating a client.\n\nThen call run().",
    ],
    bodyText:
      "Navigation Docs Install the SDK before creating a client. Then call run(). Footer",
  });

  expect(mainText).toBe(
    "Install the SDK before creating a client. Then call run().",
  );
});

test("browser extension whole-page share falls back to normalized body text", () => {
  const mainText = extractMainTextFromPage({
    primaryTextCandidates: ["Nav", "Short"],
    bodyText: "Docs\n\n  Use the current API page as context.   Footer",
  });

  expect(mainText).toBe("Docs Use the current API page as context. Footer");
});

test("browser capture supports normal web pages but not Chrome internal pages", () => {
  expect(isBrowserPageCaptureSupported("https://example.com/docs")).toBe(true);
  expect(isBrowserPageCaptureSupported("http://localhost:3000")).toBe(true);
  expect(isBrowserPageCaptureSupported("chrome://extensions")).toBe(false);
  expect(isBrowserPageCaptureSupported("chrome-extension://abcdefghijklmnop/page.html")).toBe(false);
});

test("injected page capture is self-contained when Chrome serializes only its function body", () => {
  const executeInjectedCapture = new Function(
    "document",
    "window",
    `return (${collectPageContext.toString()})();`,
  ) as (
    document: { title: string; body: unknown; querySelector(selector: string): unknown },
    window: { location: { href: string }; getSelection(): { toString(): string } },
  ) => unknown;
  const emptyRoot = { querySelectorAll: () => [] };

  expect(
    executeInjectedCapture(
      {
        title: "Documentation",
        body: emptyRoot,
        querySelector: () => emptyRoot,
      },
      {
        location: { href: "https://example.com/docs" },
        getSelection: () => ({ toString: () => "Selected text" }),
      },
    ),
  ).toEqual({
    title: "Documentation",
    selectionText: "Selected text",
    primaryBlocks: [],
    bodyBlocks: [],
    primaryRootText: "",
    primaryRootTextTruncated: false,
  });
});

interface FakePageElement {
  tagName: string;
  hidden: boolean;
  href?: string;
  parentElement: FakePageElement | null;
  children: FakePageElement[];
  readonly innerText: string;
  getAttribute(name: string): string | null;
  matches(selector: string): boolean;
  closest(selector: string): FakePageElement | null;
  querySelector(selector: string): FakePageElement | null;
  querySelectorAll(selector: string): FakePageElement[];
}

function fakePageElement(
  tag: string,
  options: { text?: string; children?: FakePageElement[]; href?: string } = {},
): FakePageElement {
  const matches = (node: FakePageElement, selector: string): boolean =>
    selector
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .includes(node.tagName.toLowerCase());
  const descendants = (node: FakePageElement): FakePageElement[] =>
    node.children.flatMap((child) => [child, ...descendants(child)]);
  const element: FakePageElement = {
    tagName: tag.toUpperCase(),
    hidden: false,
    href: options.href,
    parentElement: null,
    children: options.children ?? [],
    get innerText(): string {
      return [options.text ?? "", ...element.children.map((child) => child.innerText)]
        .filter(Boolean)
        .join("\n");
    },
    getAttribute: () => null,
    matches(selector) {
      return matches(element, selector);
    },
    closest(selector) {
      let node: FakePageElement | null = element;
      while (node) {
        if (matches(node, selector)) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector(selector) {
      return descendants(element).find((node) => matches(node, selector)) ?? null;
    },
    querySelectorAll(selector) {
      return descendants(element).filter((node) => matches(node, selector));
    },
  };
  for (const child of element.children) child.parentElement = element;
  return element;
}

function executeCollectPageContext(document: unknown, window: unknown): {
  title: string;
  selectionText: string;
  primaryBlocks: { kind: string; text?: string }[];
  bodyBlocks: { kind: string; text?: string }[];
  primaryRootText: string;
  primaryRootTextTruncated: boolean;
} {
  const run = new Function(
    "document",
    "window",
    `return (${collectPageContext.toString()})();`,
  ) as (document: unknown, window: unknown) => ReturnType<typeof executeCollectPageContext>;
  return run(document, window);
}

test("injected page capture keeps each source text once for pre>code, inline code, and nested list items", () => {
  const codeInPre = fakePageElement("code", { text: "const x = 1;" });
  const pre = fakePageElement("pre", { children: [codeInPre] });
  const inlineCode = fakePageElement("code", { text: "npm install" });
  const paragraph = fakePageElement("p", { text: "Install with", children: [inlineCode] });
  const childItem = fakePageElement("li", { text: "Child item" });
  const childList = fakePageElement("ul", { children: [childItem] });
  const parentItem = fakePageElement("li", { text: "Parent item", children: [childList] });
  const list = fakePageElement("ul", { children: [parentItem] });
  const main = fakePageElement("main", { children: [pre, paragraph, list] });
  const body = fakePageElement("body", { children: [main] });

  const context = executeCollectPageContext(
    {
      title: "Docs",
      body,
      querySelector: (selector: string) => (selector === "main" ? main : null),
    },
    {
      location: { href: "https://example.com/docs" },
      getSelection: () => ({ toString: () => "" }),
    },
  );

  expect(context.primaryBlocks).toEqual([
    { kind: "code", text: "const x = 1;" },
    { kind: "paragraph", text: "Install with\nnpm install" },
    { kind: "list_item", text: "Parent item\nChild item" },
  ]);
  expect(context.bodyBlocks).toEqual(context.primaryBlocks);
  expect(context.primaryRootText).toBe(
    "const x = 1;\nInstall with\nnpm install\nParent item\nChild item",
  );
});

test("injected page capture returns boilerplate-free body text when no primary root exists", () => {
  const header = fakePageElement("header", { text: "Global header" });
  const nestedNavigation = fakePageElement("nav", { text: "Site navigation links" });
  const marketingCopy = fakePageElement("div", {
    text: "GLM-4.5 is our flagship model. It excels at reasoning.",
  });
  const wrapper = fakePageElement("div", { children: [nestedNavigation, marketingCopy] });
  const body = fakePageElement("body", { children: [header, wrapper] });

  const context = executeCollectPageContext(
    {
      title: "Marketing",
      body,
      querySelector: () => null,
    },
    {
      location: { href: "https://example.com/model-api" },
      getSelection: () => ({ toString: () => "" }),
    },
  );

  expect(context.primaryBlocks).toEqual([]);
  expect(context.bodyBlocks).toEqual([]);
  expect(context.primaryRootText).toBe(
    "GLM-4.5 is our flagship model. It excels at reasoning.",
  );
});

test("injected page capture strips boilerplate nested inside the primary root's text", () => {
  const insideNavigation = fakePageElement("nav", { text: "In-article nav" });
  const copy = fakePageElement("p", { text: "Actual article copy." });
  const main = fakePageElement("main", { children: [insideNavigation, copy] });
  fakePageElement("body", { children: [main] });

  const context = executeCollectPageContext(
    {
      title: "Docs",
      body: main.parentElement,
      querySelector: (selector: string) => (selector === "main" ? main : null),
    },
    {
      location: { href: "https://example.com/docs" },
      getSelection: () => ({ toString: () => "" }),
    },
  );

  expect(context.primaryRootText).toBe("Actual article copy.");
});

test("browser capture falls back to primary root text when blocks cover too little of the page", async () => {
  const rootText = [
    "GLM-4.5 is our flagship model.",
    "",
    "It unifies reasoning, coding, and agentic capabilities in one stack.",
    "Pricing starts at $0.2 per million input tokens.",
  ].join("\n");
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_sparse_blocks",
    captureReadyMs: 8,
    primaryBlocks: [{ kind: "link", text: "Sign up", href: "https://example.com/signup" }],
    bodyBlocks: [],
    primaryRootText: rootText,
  });

  expect(capture.contentKind).toBe("mainText");
  expect(capture.content).toBe(rootText);
});

test("browser capture keeps structured blocks when they cover most of the page text", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_docs_page",
    captureReadyMs: 8,
    primaryBlocks: [
      { kind: "heading", text: "Install Forgelet" },
      { kind: "paragraph", text: "Install the CLI before running a session." },
    ],
    bodyBlocks: [],
    primaryRootText: "Install Forgelet\nInstall the CLI before running a session.",
  });

  expect(capture.content).toBe(
    "# Install Forgelet\n\nInstall the CLI before running a session.",
  );
});

test("browser extension share summary suggests CLI follow-up without page content", () => {
  const summary = renderShareSummary({
    ok: true,
    title: "Readable API Docs",
    url: "https://example.com/docs",
    contentKind: "mainText",
    contentBytes: 41,
    contentHash: "abc123",
    capturedAt: "2026-07-02T00:00:00.000Z",
    snapshotPath: "/Users/alice/.forgelet/browser/current-page.json",
  });

  expect(summary).toContain("Readable API Docs");
  expect(summary).toContain("mainText");
  expect(summary).toContain("41 bytes");
  expect(summary).toContain("forge browser read-current");
  expect(summary).toContain('forge code --with-browser "<task>"');
  expect(summary).not.toContain("Install the SDK before creating a client.");
});

test("browser capture prefers explicit selection and preserves meaningful line breaks", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_selection",
    captureReadyMs: 14,
    selectionText: "First paragraph.\n\nSecond paragraph.\n  Final line.",
    primaryBlocks: [
      { kind: "heading", text: "Ignored article heading" },
      { kind: "paragraph", text: "This article must lose to a selection." },
    ],
    bodyBlocks: [],
  });

  expect(capture).toMatchObject({
    contentKind: "selectedText",
    content: "First paragraph.\n\nSecond paragraph.\nFinal line.",
    captureId: "capture_selection",
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureReadyMs: 14,
  });
  expect(capture.contentBytes).toBe(
    Buffer.byteLength("First paragraph.\n\nSecond paragraph.\nFinal line.", "utf8"),
  );
  expect(capture.contentHash).toMatch(/^[a-f0-9]{64}$/);
});

test("browser capture serializes primary document blocks as bounded Markdown-like text", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_article",
    captureReadyMs: 22,
    primaryBlocks: [
      { kind: "heading", text: "Install Forgelet" },
      { kind: "paragraph", text: "Install the CLI before running a session." },
      { kind: "list_item", text: "Run npm install" },
      { kind: "code", text: "forge learn --with-browser \"summarize this\"" },
      { kind: "link", text: "Configuration", href: "https://example.com/config" },
      { kind: "table_row", cells: ["Flag", "Meaning"] },
      { kind: "table_row", cells: ["--with-browser", "Use the shared page"] },
    ],
    bodyBlocks: [{ kind: "paragraph", text: "Body fallback must not be used." }],
  });

  expect(capture.contentKind).toBe("mainText");
  expect(capture.content).toBe(
    "# Install Forgelet\n\n" +
      "Install the CLI before running a session.\n\n" +
      "- Run npm install\n\n" +
      "```\nforge learn --with-browser \"summarize this\"\n```\n\n" +
      "[Configuration](https://example.com/config)\n\n" +
      "| Flag | Meaning |\n\n" +
      "| --with-browser | Use the shared page |",
  );
});

test("browser capture excludes boilerplate and enforces UTF-8 block and total limits", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_limited",
    captureReadyMs: 5,
    primaryBlocks: [
      { kind: "navigation", text: "Navigation must be excluded" },
      { kind: "script", text: "window.secret = 'must be excluded'" },
      { kind: "style", text: ".hidden { display: none }" },
      { kind: "paragraph", text: "ééééé" },
      { kind: "paragraph", text: "second block" },
    ],
    bodyBlocks: [],
    limits: { maxBlockBytes: 5, maxTotalBytes: 7 },
  });

  expect(capture.content).toBe("éé");
  expect(capture.contentBytes).toBe(4);
  expect(capture.content).not.toContain("Navigation");
  expect(capture.content).not.toContain("secret");
  expect(capture.content).not.toContain("hidden");
  expect(capture.truncated).toBe(true);
});

test("browser capture marks a selected source truncated at the total UTF-8 limit", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_truncated_selection",
    captureReadyMs: 5,
    selectionText: "ééé",
    primaryBlocks: [],
    bodyBlocks: [],
    limits: { maxTotalBytes: 5 },
  });

  expect(capture).toMatchObject({
    contentKind: "selectedText",
    content: "éé",
    truncated: true,
  });
});

test("browser capture marks fallback source text truncated at the total UTF-8 limit", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_truncated_fallback",
    captureReadyMs: 5,
    primaryBlocks: [{ kind: "link", text: "short", href: "https://example.com" }],
    bodyBlocks: [],
    primaryRootText: "A source body that requires fallback.",
    limits: { maxTotalBytes: 12 },
  });

  expect(capture).toMatchObject({ content: "A source bod", truncated: true });
});

test("browser capture preserves source coverage metadata when page collection already capped fallback text", async () => {
  const capture = await createBrowserCapture({
    capturedAt: "2026-07-12T00:00:00.000Z",
    captureId: "capture_collector_capped",
    captureReadyMs: 5,
    primaryBlocks: [],
    bodyBlocks: [],
    primaryRootText: "The first bounded portion of a page.",
    primaryRootTextTruncated: true,
  });

  expect(capture).toMatchObject({ truncated: true });
});

test("Browser Workbench manifest uses a Side Panel and a clear toolbar action without a popup", () => {
  const manifest = browserExtensionManifest();

  expect(manifest.action).toEqual({ default_title: "Summarize current page" });
  expect(manifest.side_panel).toEqual({ default_path: "sidePanel.html" });
  expect(manifest.permissions).toContain("sidePanel");
  expect(JSON.stringify(manifest)).not.toContain("default_popup");
});

test("browser extension build includes every local Service Worker dependency", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-extension-build-"));
  const previousCwd = process.cwd();
  try {
    const compiledDir = join(workspaceRoot, "dist", "browser", "extension");
    await mkdir(compiledDir, { recursive: true });
    const compiledFiles = [
      "serviceWorker.js",
      "pageConversationController.js",
      "pageConversationProjection.js",
      "pageConversationStore.js",
      "sidePanel.js",
      "snapshotProducer.js",
    ];
    await Promise.all(
      compiledFiles.map((fileName) => writeFile(join(compiledDir, fileName), `// ${fileName}\n`, "utf8")),
    );

    process.chdir(workspaceRoot);
    await buildBrowserExtension();

    expect(
      await readdir(join(workspaceRoot, "dist", "browser-extension")),
    ).toEqual(expect.arrayContaining(compiledFiles));
  } finally {
    process.chdir(previousCwd);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});


function projectionFixture(overrides: Partial<PageConversationProjection> = {}): PageConversationProjection {
  const base = createPageConversationProjection({
    conversationId: "conversation_1",
    actionId: "action_1",
    invocationId: "invocation_1",
    workspaceProfileId: "profile_1",
    captureId: "capture_1",
    source: { url: "https://example.com/docs", title: "Example Docs", capturedAt: "2026-07-14T00:00:00.000Z", truncated: false },
  });
  return { ...base, currentAttempt: undefined, ...overrides };
}

test("the source header always shows captured title, URL, capture time, and a partial badge only when truncated", () => {
  const truncated = projectionFixture({ source: { url: "https://example.com/a", title: "A", capturedAt: "2026-07-14T00:00:00.000Z", truncated: true } });
  const view = buildSidePanelViewModel({ projection: truncated, language: "en" });
  expect(view.source).toEqual({ url: "https://example.com/a", title: "A", capturedAt: "2026-07-14T00:00:00.000Z", partial: true });

  const full = projectionFixture({ source: { url: "https://example.com/b", title: "B", capturedAt: "2026-07-14T00:00:00.000Z", truncated: false } });
  expect(buildSidePanelViewModel({ projection: full, language: "en" }).source?.partial).toBe(false);
});

test("a Page Brief renders as the root turn with only its two English section titles", () => {
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "简明摘要", keyConcepts: "- 核心概念" } }],
  });
  const view = buildSidePanelViewModel({ projection, language: "en" });
  expect(view.turns).toEqual([
    {
      kind: "root",
      pageBriefSections: [
        { title: "Summary", blocks: [{ kind: "paragraph", children: [{ kind: "text", text: "简明摘要" }] }] },
        { title: "Key Concepts", blocks: [{ kind: "list_item", children: [{ kind: "text", text: "核心概念" }] }] },
      ],
    },
  ]);
});

test("a completed follow-up renders Answer and Evidence, and a not-found grounding status shows a deterministic localized message instead of the raw sentinel", () => {
  const supportedProjection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_f1",
    turns: [
      { invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } },
      { invocationId: "invocation_2", sessionId: "sess_f1", kind: "follow_up", question: "Is there a changelog?", pageAnswer: { answer: "Yes, in the docs.", groundingStatus: "supported", evidence: ["A captured passage."] } },
    ],
  });
  const supportedView = buildSidePanelViewModel({ projection: supportedProjection, language: "en" });
  expect(supportedView.turns[1]).toMatchObject({
    kind: "follow_up",
    question: "Is there a changelog?",
    evidence: { groundingStatus: "supported", excerpts: ["A captured passage."] },
  });

  const notFoundProjection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_f1",
    turns: [
      { invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } },
      { invocationId: "invocation_2", sessionId: "sess_f1", kind: "follow_up", question: "Any pricing info?", pageAnswer: { answer: "The page does not mention pricing.", groundingStatus: "not_found", evidence: [] } },
    ],
  });
  const notFoundView = buildSidePanelViewModel({ projection: notFoundProjection, language: "en" });
  expect(notFoundView.turns[1]?.evidence).toEqual({
    groundingStatus: "not_found",
    excerpts: [],
    notFoundMessage: "Not backed by a passage in the captured page.",
  });
  expect(notFoundView.turns[1]?.evidence?.notFoundMessage).not.toContain("No supporting passage in the captured page.");

  const zhView = buildSidePanelViewModel({ projection: notFoundProjection, language: "zh-CN" });
  expect(zhView.turns[1]?.evidence?.notFoundMessage).toBe("并非源自已捕获页面中的段落。");
});

test("input is enabled only after a successful root and disabled again while an attempt runs", () => {
  const beforeRoot = projectionFixture();
  expect(buildSidePanelViewModel({ projection: beforeRoot, language: "en" }).inputEnabled).toBe(false);

  const afterRoot = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
  });
  expect(buildSidePanelViewModel({ projection: afterRoot, language: "en" }).inputEnabled).toBe(true);

  const running = { ...afterRoot, currentAttempt: { invocationId: "invocation_2", actionId: "action_2", kind: "follow_up" as const, status: "running" as const } };
  expect(buildSidePanelViewModel({ projection: running, language: "en" }).inputEnabled).toBe(false);
});

test("follow-up validation rejects blank and oversized input but allows multiline text", () => {
  expect(validateFollowUpQuestion("   \n  ")).toEqual({ ok: false, message: expect.stringContaining("Enter a question") });
  expect(validateFollowUpQuestion("Line one\nLine two")).toEqual({ ok: true, question: "Line one\nLine two" });
  expect(validateFollowUpQuestion("é".repeat(3000))).toEqual({ ok: false, message: expect.stringMatching(/too long/i) });
});

test("failed and stopped attempts render a terminal card with question, reason, Session ID when present, and a Retry control", () => {
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
    terminalCards: [
      { invocationId: "invocation_2", kind: "follow_up", status: "failed", reason: "invalid_page_answer", question: "Why?", sessionId: "sess_f1" },
      { invocationId: "invocation_3", kind: "follow_up", status: "stopped", reason: "user_stopped", question: "And then?" },
    ],
  });
  const view = buildSidePanelViewModel({ projection, language: "en" });
  expect(view.terminalCards).toEqual([
    { invocationId: "invocation_2", kind: "follow_up", status: "failed", question: "Why?", reason: "invalid_page_answer", sessionId: "sess_f1" },
    { invocationId: "invocation_3", kind: "follow_up", status: "stopped", question: "And then?", reason: "user_stopped" },
  ]);

  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  const retried: string[] = [];
  renderSidePanelState(doc, container, view, (invocationId) => retried.push(invocationId));
  const retryButtons = findNodes(container, (node) => node.tagName === "BUTTON" && node.textContent === "Retry");
  expect(retryButtons).toHaveLength(2);
  retryButtons[0]?.dispatchClick?.();
  expect(retried).toEqual(["invocation_2"]);
  expect(container.textContent).toContain("sess_f1");
});

test("a failed attempt renders its streamed text as an explicitly unverified draft", () => {
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
    terminalCards: [
      {
        invocationId: "invocation_2",
        kind: "follow_up",
        status: "failed",
        reason: "invalid_page_answer",
        question: "Why?",
        sessionId: "sess_f1",
        streamedText: "A partially streamed answer.",
      },
    ],
  });

  const view = buildSidePanelViewModel({ projection, language: "en" });
  expect(view.terminalCards[0]).toMatchObject({
    streamedText: "A partially streamed answer.",
    streamedTextLabel: "Unverified streamed draft",
  });

  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  renderSidePanelState(doc, container, view);
  expect(container.textContent).toContain("Unverified streamed draft");
  expect(container.textContent).toContain("A partially streamed answer.");
});

test("a Page Conversation with no attempt in flight renders no stream element, and the evicted-history indicator is visible after eviction", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
    historyEvicted: true,
  });
  const view = buildSidePanelViewModel({ projection, language: "en" });
  const { streamElement } = renderSidePanelState(doc, container, view);
  expect(streamElement).toBeUndefined();
  expect(container.textContent).toContain("Earlier turns remain in the Session Traces on disk.");
});

test("Side Panel renders model/page content as text nodes, never HTML", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_f1",
    source: { url: "https://example.com", title: "<img src=x onerror=alert(1)>", capturedAt: "2026-07-14T00:00:00.000Z", truncated: false },
    turns: [
      { invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "raw <b>summary</b>", keyConcepts: "- **bold** concept" } },
      { invocationId: "invocation_2", sessionId: "sess_f1", kind: "follow_up", question: "<script>alert(1)</script>", pageAnswer: { answer: "See <b>the docs</b>.", groundingStatus: "supported", evidence: ["<img src=x>"] } },
    ],
  });
  const view = buildSidePanelViewModel({ projection, language: "en" });

  renderSidePanelState(doc, container, view);

  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(container.textContent).toContain("raw <b>summary</b>");
  expect(container.textContent).toContain("bold");
  expect(container.textContent).toContain("<script>alert(1)</script>");
  expect(container.textContent).toContain("See <b>the docs</b>.");
  expect(container.textContent).toContain("<img src=x>");
});

test("Side Panel appends stream deltas to the stream element without a re-render", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
    currentAttempt: { invocationId: "invocation_2", actionId: "action_2", kind: "follow_up", status: "running", liveText: "First " },
  });
  const view = buildSidePanelViewModel({ projection, language: "en" });

  const { streamElement } = renderSidePanelState(doc, container, view);

  expect(streamElement?.textContent).toBe("First ");
  streamElement.textContent += "delta";
  expect(container.textContent).toContain("First delta");
});

test("Side Panel places a new streaming follow-up below every earlier attempt card", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
    terminalCards: [
      { invocationId: "invocation_2", kind: "follow_up", status: "failed", reason: "invalid_page_answer", question: "Earlier question" },
    ],
    currentAttempt: { invocationId: "invocation_3", actionId: "action_3", kind: "follow_up", status: "running", question: "Newest question", liveText: "Newest streamed answer" },
  });

  renderSidePanelState(doc, container, buildSidePanelViewModel({ projection, language: "en" }));

  const classes = container.children.map((node: any) => node.attributes.class);
  expect(classes.indexOf("terminal-card terminal-card-failed")).toBeLessThan(classes.indexOf("status-line"));
  expect(classes.indexOf("question")).toBeLessThan(classes.indexOf("status-line"));
});

test("Side Panel keeps a newly completed follow-up below every earlier attempt card", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_newest",
    turns: [
      { invocationId: "invocation_1", sessionId: "sess_root", kind: "root", order: 0, pageBrief: { summary: "S", keyConcepts: "- K" } },
      { invocationId: "invocation_2", sessionId: "sess_prior", kind: "follow_up", order: 1, question: "Earlier successful question", pageAnswer: { answer: "Earlier answer", groundingStatus: "supported", evidence: ["Earlier evidence"] } },
      { invocationId: "invocation_4", sessionId: "sess_newest", kind: "follow_up", order: 3, question: "Newest completed question", pageAnswer: { answer: "Newest completed answer", groundingStatus: "supported", evidence: ["Newest evidence"] } },
    ],
    terminalCards: [
      { invocationId: "invocation_3", kind: "follow_up", status: "failed", order: 2, reason: "invalid_page_answer", question: "Earlier failed question" },
    ],
  });

  renderSidePanelState(doc, container, buildSidePanelViewModel({ projection, language: "en" }));

  const terminalCardIndex = container.children.findIndex(
    (node: any) => node.attributes.class === "terminal-card terminal-card-failed",
  );
  const newestQuestionIndex = container.children.findIndex(
    (node: any) => node.textContent === "Newest completed question",
  );
  expect(terminalCardIndex).toBeLessThan(newestQuestionIndex);
});

function fakePanelDocument(): { createElement(tag: string): any } {
  const createElement = (tag: string): any => {
    const listeners: Record<string, (() => void)[]> = {};
    const node: any = {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: {} as Record<string, string>,
      appendChild(child: any) {
        node.children.push(child);
        return child;
      },
      setAttribute(name: string, value: string) {
        node.attributes[name] = value;
      },
      addEventListener(type: string, listener: () => void) {
        (listeners[type] ??= []).push(listener);
      },
      dispatchClick() {
        for (const listener of listeners.click ?? []) listener();
      },
    };
    let ownText = "";
    Object.defineProperty(node, "textContent", {
      get: () => ownText + node.children.map((child: any) => child.textContent).join("\n"),
      set: (value: string) => {
        ownText = value;
        node.children.length = 0;
      },
    });
    Object.defineProperty(node, "innerHTML", {
      set: () => {
        throw new Error("innerHTML is forbidden in the Side Panel renderer");
      },
    });
    return node;
  };
  return { createElement };
}

function findNodes(node: any, matches: (node: any) => boolean): any[] {
  const children: any[] = node.children ?? [];
  return [
    ...(matches(node) ? [node] : []),
    ...children.flatMap((child) => findNodes(child, matches)),
  ];
}

test("Side Panel page uses a fixed dark theme with color tokens and a Send composer", () => {
  const html = sidePanelHtml();

  expect(html).toContain("--bg:");
  expect(html).toContain("--fg:");
  expect(html).toContain("background: var(--bg)");
  expect(html).toContain('id="workbench-root"');
  expect(html).toContain('id="stop"');
  expect(html).toContain('id="output-language"');
  expect(html).toContain('option value="auto"');
  expect(html).toContain('option value="zh-CN"');
  expect(html).toContain('id="question"');
  expect(html).toContain('id="send"');
  expect(html).not.toContain("#ffffff");
});

test("Side Panel keeps settings in a footer below the content, the composer above it, and offers a text-size preference", () => {
  const html = sidePanelHtml();

  expect(html).toContain('id="font-size"');
  expect(html).toContain('option value="medium"');
  expect(html).toContain("--content-font-size");
  expect(html.indexOf('id="workbench-root"')).toBeLessThan(html.indexOf('id="question"'));
  expect(html.indexOf('id="question"')).toBeLessThan(html.indexOf('id="output-language"'));
  expect(html.indexOf('id="workbench-root"')).toBeLessThan(html.indexOf('id="font-size"'));
  // The Stop action stays in the header above the content.
  expect(html.indexOf('id="stop"')).toBeLessThan(html.indexOf('id="workbench-root"'));
});

test("font-size normalization keeps known sizes and falls back to medium", () => {
  expect(normalizeFontSizePreference("small")).toBe("small");
  expect(normalizeFontSizePreference("medium")).toBe("medium");
  expect(normalizeFontSizePreference("large")).toBe("large");
  expect(normalizeFontSizePreference("xlarge")).toBe("xlarge");
  expect(normalizeFontSizePreference("huge")).toBe("medium");
  expect(normalizeFontSizePreference(undefined)).toBe("medium");
  expect(normalizeFontSizePreference(16)).toBe("medium");
});

test("Side Panel language normalization only recognizes zh-CN, defaulting everything else to English", () => {
  expect(normalizeSidePanelLanguage("zh-CN")).toBe("zh-CN");
  expect(normalizeSidePanelLanguage("en")).toBe("en");
  expect(normalizeSidePanelLanguage("auto")).toBe("en");
  expect(normalizeSidePanelLanguage(undefined)).toBe("en");
});

test("Side Panel tolerates a reattach request when no Service Worker receiver exists", async () => {
  await expect(
    requestPageConversationProjection(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }, 1),
  ).resolves.toBeUndefined();
});

test("an empty conversation shows the deterministic prompt to use the toolbar action, localized without a model call", () => {
  const view = buildSidePanelViewModel({ projection: undefined, language: "en" });
  expect(view.hasConversation).toBe(false);
  expect(view.emptyMessage).toBe("Click the toolbar action to summarize the current page.");

  const zhView = buildSidePanelViewModel({ projection: undefined, language: "zh-CN" });
  expect(zhView.emptyMessage).toBe("点击工具栏按钮以总结当前页面。");
});

test("a notice from the controller (capture unavailable, needs profile, attempt in progress) is surfaced without replacing the conversation view", () => {
  const projection = projectionFixture({
    rootSessionId: "sess_root",
    headSessionId: "sess_root",
    turns: [{ invocationId: "invocation_1", sessionId: "sess_root", kind: "root", pageBrief: { summary: "S", keyConcepts: "- K" } }],
  });
  const view = buildSidePanelViewModel({
    projection,
    notice: { kind: "attempt_in_progress", message: "A Browser Workbench attempt is already running in this window. Wait for it to finish or Stop it." },
    language: "en",
  });
  expect(view.noticeMessage).toBe("A Browser Workbench attempt is already running in this window. Wait for it to finish or Stop it.");
  expect(view.turns).toHaveLength(1);
});
