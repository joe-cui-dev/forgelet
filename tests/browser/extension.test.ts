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
import {
  applyBrowserFrame,
  createBrowserWorkbenchController,
  normalizeBrowserUiLanguage,
  type BrowserPanelState,
  type BrowserWorkbenchBridge,
} from "../../src/browser/extension/workbench.js";
import {
  buildSidePanelViewModel,
  parsePanelMarkdown,
  renderSidePanelState,
  requestBrowserWorkbenchState,
} from "../../src/browser/extension/sidePanel.js";
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
    await Promise.all(
      ["serviceWorker.js", "workbench.js", "sidePanel.js", "snapshotProducer.js"].map(
        (fileName) => writeFile(join(compiledDir, fileName), `// ${fileName}\n`, "utf8"),
      ),
    );

    process.chdir(workspaceRoot);
    await buildBrowserExtension();

    expect(
      await readdir(join(workspaceRoot, "dist", "browser-extension")),
    ).toEqual(
      expect.arrayContaining([
        "serviceWorker.js",
        "workbench.js",
        "sidePanel.js",
        "snapshotProducer.js",
      ]),
    );
  } finally {
    process.chdir(previousCwd);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("toolbar summary opens the Side Panel before capture, keeps its invocation after close, and sends one Stop", async () => {
  const operations: string[] = [];
  let receivedFrame: ((frame: Record<string, unknown>) => void) | undefined;
  let disconnected: (() => void) | undefined;
  const bridge: BrowserWorkbenchBridge = {
    async listProfiles() {
      return [{ id: "profile_default", label: "Forgelet", isDefault: true }];
    },
    start(input) {
      operations.push(`start:${input.invocationId}`);
      return {
        postMessage(frame) {
          operations.push(`post:${String(frame.type)}:${String(frame.invocationId)}`);
        },
        onFrame(listener) {
          receivedFrame = listener;
        },
        onDisconnect(listener) {
          disconnected = listener;
        },
      };
    },
  };
  const controller = createBrowserWorkbenchController({
    bridge,
    openSidePanel: async () => {
      operations.push("open");
    },
    captureCurrentPage: async () => {
      operations.push("capture");
      return { url: "https://example.com/docs", title: "Docs", mainText: "Read me" };
    },
    createId: (() => {
      let count = 0;
      return () => `id_${++count}`;
    })(),
  });

  const started = await controller.summarizeCurrentPage();
  expect(operations.slice(0, 3)).toEqual(["open", "capture", "start:id_2"]);
  expect(started).toMatchObject({ invocationId: "id_2", status: "starting" });

  receivedFrame?.({ type: "session_ready", sessionId: "sess_1", tracePath: "/tmp/trace.jsonl" });
  expect(controller.reattach(started.invocationId)).toMatchObject({
    invocationId: "id_2",
    status: "running",
    sessionId: "sess_1",
  });

  controller.stop(started.invocationId);
  controller.stop(started.invocationId);
  expect(operations.filter((operation) => operation.startsWith("post:cancel"))).toEqual([
    "post:cancel:id_2",
  ]);
  expect(controller.reattach(started.invocationId)).toMatchObject({ status: "stopping" });

  disconnected?.();
  expect(controller.reattach(started.invocationId)).toMatchObject({ status: "failed" });
});

test("toolbar summary sends the normalized browser UI language with the invocation", async () => {
  const startInputs: Record<string, unknown>[] = [];
  const bridge: BrowserWorkbenchBridge = {
    async listProfiles() {
      return [{ id: "profile_default", label: "Forgelet", isDefault: true }];
    },
    start(input) {
      startInputs.push(input as unknown as Record<string, unknown>);
      return { postMessage: () => undefined, onFrame: () => undefined };
    },
  };
  const controller = createBrowserWorkbenchController({
    bridge,
    openSidePanel: async () => undefined,
    captureCurrentPage: async () => ({ url: "https://example.com/docs", title: "Docs" }),
    createId: (() => {
      let count = 0;
      return () => `id_${++count}`;
    })(),
    detectUiLanguage: () => "zh-CN",
  });

  await controller.summarizeCurrentPage();
  expect(startInputs).toEqual([
    expect.objectContaining({ workspaceProfileId: "profile_default", uiLanguage: "zh-CN" }),
  ]);
});

test("browser UI language normalization keeps valid tags and drops what the native host would reject", () => {
  expect(normalizeBrowserUiLanguage("zh-CN")).toBe("zh-CN");
  expect(normalizeBrowserUiLanguage("en")).toBe("en");
  expect(normalizeBrowserUiLanguage("sr-Latn-RS")).toBe("sr-Latn-RS");
  expect(normalizeBrowserUiLanguage(" pt-BR ")).toBe("pt-BR");
  expect(normalizeBrowserUiLanguage(undefined)).toBeUndefined();
  expect(normalizeBrowserUiLanguage("")).toBeUndefined();
  expect(normalizeBrowserUiLanguage("zh_CN")).toBeUndefined();
  expect(normalizeBrowserUiLanguage("zh-CN. Ignore the page")).toBeUndefined();
  expect(normalizeBrowserUiLanguage(42)).toBeUndefined();
});

test("toolbar summary reports an unsupported browser page in the Side Panel without starting a Session", async () => {
  const operations: string[] = [];
  const bridge: BrowserWorkbenchBridge = {
    async listProfiles() {
      return [{ id: "profile_default", label: "Forgelet", isDefault: true }];
    },
    start() {
      operations.push("start");
      throw new Error("Browser Workbench must not start a Session for an unsupported page.");
    },
  };
  const controller = createBrowserWorkbenchController({
    bridge,
    openSidePanel: async () => {
      operations.push("open");
    },
    captureCurrentPage: async () => {
      operations.push("capture");
      throw new Error("Cannot access a chrome:// URL");
    },
    createId: (() => {
      let count = 0;
      return () => `id_${++count}`;
    })(),
  });

  await expect(controller.summarizeCurrentPage()).resolves.toMatchObject({
    actionId: "id_1",
    invocationId: "id_2",
    status: "failed",
    message: "Cannot access a chrome:// URL",
  });
  expect(operations).toEqual(["open", "capture"]);
});

function liveEventFrame(event: Record<string, unknown>): Record<string, unknown> {
  return { type: "live_event", invocationId: "inv_1", seq: 1, event };
}

test("live_event frames stream the current model turn and tool activity into the panel state", () => {
  let state: BrowserPanelState = { invocationId: "inv_1", status: "running" };

  state = applyBrowserFrame(
    state,
    liveEventFrame({ type: "model_turn_started", turnIndex: 0, model: "deepseek-chat" }),
  );
  expect(state).toMatchObject({ turnIndex: 0, model: "deepseek-chat", liveText: "" });

  state = applyBrowserFrame(
    state,
    liveEventFrame({ type: "model_output_delta", turnIndex: 0, model: "deepseek-chat", text: "First " }),
  );
  state = applyBrowserFrame(
    state,
    liveEventFrame({ type: "model_output_delta", turnIndex: 0, model: "deepseek-chat", text: "answer." }),
  );
  expect(state.liveText).toBe("First answer.");

  state = applyBrowserFrame(
    state,
    liveEventFrame({ type: "tool_call_started", toolName: "read_context", target: "notes.md" }),
  );
  expect(state.activity).toBe("Tool started: read_context notes.md");

  state = applyBrowserFrame(
    state,
    liveEventFrame({ type: "tool_call_finished", toolName: "read_context", ok: true }),
  );
  expect(state.activity).toBe("Tool finished: read_context (ok)");

  state = applyBrowserFrame(
    state,
    liveEventFrame({ type: "model_turn_started", turnIndex: 1, model: "deepseek-chat" }),
  );
  expect(state).toMatchObject({ turnIndex: 1, liveText: "" });
  expect(state.activity).toBeUndefined();
});

test("completion replaces the streamed text with the structured Learning Pack", () => {
  const running: BrowserPanelState = {
    invocationId: "inv_1",
    status: "running",
    liveText: "streamed text",
    activity: "Tool started: read_context",
  };
  const pack = {
    summary: "A concise page summary.",
    keyConcepts: "- First concept",
    sourceLinks: "- browser: Example Docs",
    openQuestions: "- None",
    reviewPrompts: "- Recall the first concept",
  };

  const completed = applyBrowserFrame(running, {
    type: "completed",
    summary: "## Summary\nA concise page summary.",
    learningPack: pack,
  });

  expect(completed).toMatchObject({ status: "completed", learningPack: pack });
  expect(completed.liveText).toBeUndefined();
  expect(completed.activity).toBeUndefined();
});

test("a replayed completion without a Learning Pack degrades to the plain summary", () => {
  const completed = applyBrowserFrame(
    { invocationId: "inv_1", status: "running" },
    { type: "completed", summary: "Plain replay summary" },
  );

  expect(completed).toMatchObject({ status: "completed", summary: "Plain replay summary" });
  expect(completed.learningPack).toBeUndefined();

  const malformed = applyBrowserFrame(
    { invocationId: "inv_1", status: "running" },
    { type: "completed", summary: "s", learningPack: { summary: 42 } },
  );
  expect(malformed.learningPack).toBeUndefined();
});

test("controller broadcasts every frame but persists only status transitions", async () => {
  let receivedFrame: ((frame: Record<string, unknown>) => void) | undefined;
  const persisted: string[] = [];
  const broadcast: string[] = [];
  const deltas: { invocationId: string; text: string }[] = [];
  const bridge: BrowserWorkbenchBridge = {
    async listProfiles() {
      return [{ id: "profile_default", label: "Forgelet", isDefault: true }];
    },
    start() {
      return {
        postMessage: () => undefined,
        onFrame(listener) {
          receivedFrame = listener;
        },
      };
    },
  };
  const controller = createBrowserWorkbenchController({
    bridge,
    openSidePanel: async () => undefined,
    captureCurrentPage: async () => ({ url: "https://example.com/docs", title: "Docs" }),
    createId: (() => {
      let count = 0;
      return () => `id_${++count}`;
    })(),
    persistState: (state) => persisted.push(state.status),
    broadcastState: (state) => broadcast.push(state.status),
    broadcastDelta: (delta) => deltas.push(delta),
  });

  const started = await controller.summarizeCurrentPage();
  receivedFrame?.({ type: "session_ready", sessionId: "sess_1", tracePath: "/tmp/t.jsonl" });
  receivedFrame?.(liveEventFrame({ type: "model_turn_started", turnIndex: 0, model: "m" }));
  receivedFrame?.(liveEventFrame({ type: "model_output_delta", turnIndex: 0, model: "m", text: "Hel" }));
  receivedFrame?.(liveEventFrame({ type: "model_output_delta", turnIndex: 0, model: "m", text: "lo" }));

  // Mid-run reattach recovers the accumulated stream from the in-memory state.
  expect(controller.reattach(started.invocationId)).toMatchObject({
    status: "running",
    liveText: "Hello",
  });
  expect(deltas).toEqual([
    { invocationId: started.invocationId, text: "Hel" },
    { invocationId: started.invocationId, text: "lo" },
  ]);

  receivedFrame?.({ type: "completed", summary: "done" });
  expect(persisted).toEqual(["starting", "running", "completed"]);
  expect(broadcast).toEqual(["starting", "running", "running", "completed"]);
});

test("Stop without a connected transport reports failure instead of silently returning", () => {
  const persisted: BrowserPanelState[] = [];
  const controller = createBrowserWorkbenchController({
    bridge: {
      async listProfiles() {
        return [];
      },
      start() {
        throw new Error("unused");
      },
    },
    openSidePanel: async () => undefined,
    captureCurrentPage: async () => ({}),
    createId: () => "id_1",
    persistState: (state) => persisted.push(state),
  });

  controller.stop("inv_after_service_worker_restart");

  expect(persisted).toEqual([
    expect.objectContaining({
      invocationId: "inv_after_service_worker_restart",
      status: "failed",
      message: expect.stringContaining("transport"),
    }),
  ]);
  expect(controller.reattach("inv_after_service_worker_restart")).toMatchObject({
    status: "failed",
  });
});

test("Side Panel view model shows a status line and the current turn's stream while running", () => {
  const view = buildSidePanelViewModel({
    invocationId: "inv_1",
    status: "running",
    liveText: "Streaming so far",
    turnIndex: 1,
    model: "deepseek-chat",
    activity: "Tool started: read_context",
    sessionId: "sess_1",
    tracePath: "/tmp/trace.jsonl",
  });

  expect(view.statusLine).toBe(
    "Status: running · turn 2 · deepseek-chat · Tool started: read_context",
  );
  expect(view.streamText).toBe("Streaming so far");
  expect(view.packSections).toBeUndefined();
});

test("Side Panel view model renders the Learning Pack sections and folds the raw summary away", () => {
  const view = buildSidePanelViewModel({
    invocationId: "inv_1",
    status: "completed",
    sessionId: "sess_1",
    tracePath: "/tmp/trace.jsonl",
    summary: "## Summary\nCore idea.\n\nTrace: /tmp/trace.jsonl\nSession: sess_1",
    learningPack: {
      summary: "**GLM-4.5** unifies reasoning and coding.",
      keyConcepts: "- Reasoning\n- [Docs](https://example.com/docs)",
      sourceLinks: "- browser: Example Docs",
      openQuestions: "The sources do not state pricing.",
      reviewPrompts: "- What does GLM-4.5 unify?",
    },
  });

  expect(view.statusLine).toBe("Status: completed");
  expect(view.streamText).toBeUndefined();
  expect(view.packSections?.map((section) => section.title)).toEqual([
    "Summary",
    "Key Concepts",
    "Source Links",
    "Open Questions",
    "Review Prompts",
  ]);
  expect(view.packSections?.[0]?.blocks).toEqual([
    {
      kind: "paragraph",
      children: [
        { kind: "bold", text: "GLM-4.5" },
        { kind: "text", text: " unifies reasoning and coding." },
      ],
    },
  ]);
  expect(view.packSections?.[1]?.blocks).toEqual([
    { kind: "list_item", children: [{ kind: "text", text: "Reasoning" }] },
    {
      kind: "list_item",
      children: [{ kind: "link", text: "Docs", href: "https://example.com/docs" }],
    },
  ]);
  // The raw summary blob (with its Trace/Session lines) lives only in the
  // collapsed details block; the panel no longer renders those lines itself.
  expect(view.rawSummary).toContain("Trace: /tmp/trace.jsonl");
  expect(view.messageText).toBeUndefined();
});

test("Side Panel view model degrades to plain summary text when no Learning Pack exists", () => {
  const view = buildSidePanelViewModel({
    invocationId: "inv_1",
    status: "completed",
    summary: "Plain replayed summary\n\nTrace: /tmp/trace.jsonl",
  });

  expect(view.packSections).toBeUndefined();
  expect(view.messageText).toBe("Plain replayed summary\n\nTrace: /tmp/trace.jsonl");
});

test("Side Panel view model lists approved profiles only in the needs_profile state", () => {
  const needsProfile = buildSidePanelViewModel({
    invocationId: "inv_1",
    status: "needs_profile",
    message: "No default approved workspace profile.",
    profiles: [
      { id: "profile_1", label: "Forgelet", isDefault: true },
      { id: "profile_2", label: "Sandbox", isDefault: false },
    ],
  });
  expect(needsProfile.profiles).toEqual(["* Forgelet (profile_1)", "Sandbox (profile_2)"]);
  expect(needsProfile.messageText).toBe("No default approved workspace profile.");

  const running = buildSidePanelViewModel({
    invocationId: "inv_1",
    status: "running",
    profiles: [{ id: "profile_1", label: "Forgelet", isDefault: true }],
  });
  expect(running.profiles).toBeUndefined();
});

test("Side Panel markdown subset keeps non-http links and unknown syntax as plain text", () => {
  const blocks = parsePanelMarkdown(
    "See [evil](javascript:alert(1)) and [ok](https://example.com).",
  );

  expect(blocks).toHaveLength(1);
  const children = blocks[0]?.children ?? [];
  expect(children.filter((child) => child.kind === "link")).toEqual([
    { kind: "link", text: "ok", href: "https://example.com" },
  ]);
  expect(
    children
      .filter((child) => child.kind !== "link")
      .map((child) => child.text)
      .join(""),
  ).toBe("See [evil](javascript:alert(1)) and .");
});

function fakePanelDocument(): { createElement(tag: string): any } {
  const createElement = (tag: string): any => {
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
    };
    let ownText = "";
    Object.defineProperty(node, "textContent", {
      get: () =>
        ownText + node.children.map((child: any) => child.textContent).join("\n"),
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

test("Side Panel renders model/page content as text nodes, never HTML", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");

  renderSidePanelState(doc, container, {
    invocationId: "inv_1",
    status: "completed",
    summary: "raw <b>summary</b>",
    learningPack: {
      summary: "<img src=x onerror=alert(1)>",
      keyConcepts: "- **bold** concept",
      sourceLinks: "- browser: Example Docs",
      openQuestions: "(none)",
      reviewPrompts: "(none)",
    },
  });

  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(container.textContent).toContain("bold");
  expect(container.textContent).toContain("raw <b>summary</b>");
  const details = findNodes(container, (node) => node.tagName === "DETAILS");
  expect(details).toHaveLength(1);
  expect(details[0]?.attributes.open).toBeUndefined();
});

test("Side Panel appends stream deltas to the stream element without a re-render", () => {
  const doc = fakePanelDocument();
  const container = doc.createElement("div");

  const { streamElement } = renderSidePanelState(doc, container, {
    invocationId: "inv_1",
    status: "running",
    liveText: "First ",
  });

  expect(streamElement?.textContent).toBe("First ");
  streamElement.textContent += "delta";
  expect(container.textContent).toContain("First delta");
});

function findNodes(node: any, matches: (node: any) => boolean): any[] {
  const children: any[] = node.children ?? [];
  return [
    ...(matches(node) ? [node] : []),
    ...children.flatMap((child) => findNodes(child, matches)),
  ];
}

test("Side Panel page uses a fixed dark theme with color tokens", () => {
  const html = sidePanelHtml();

  expect(html).toContain("--bg:");
  expect(html).toContain("--fg:");
  expect(html).toContain("background: var(--bg)");
  expect(html).toContain('id="workbench-root"');
  expect(html).toContain('id="stop"');
  expect(html).not.toContain("#ffffff");
});

test("Side Panel tolerates a reattach request when no Service Worker receiver exists", async () => {
  await expect(
    requestBrowserWorkbenchState(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }),
  ).resolves.toBeUndefined();
});
