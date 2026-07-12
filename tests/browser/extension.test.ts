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
  createBrowserWorkbenchController,
  normalizeBrowserUiLanguage,
  type BrowserWorkbenchBridge,
} from "../../src/browser/extension/workbench.js";
import {
  renderSidePanelState,
  requestBrowserWorkbenchState,
} from "../../src/browser/extension/sidePanel.js";

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
  });
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

test("Side Panel status is rendered as text, never model/page HTML", () => {
  const target = { textContent: "" };
  renderSidePanelState(target, {
    invocationId: "inv_1",
    status: "completed",
    summary: "<img src=x onerror=alert(1)>",
  });

  expect(target.textContent).toContain("<img src=x onerror=alert(1)>");
});

test("Side Panel tolerates a reattach request when no Service Worker receiver exists", async () => {
  await expect(
    requestBrowserWorkbenchState(async () => {
      throw new Error("Could not establish connection. Receiving end does not exist.");
    }),
  ).resolves.toBeUndefined();
});
