import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildBrowserExtension(): Promise<void> {
  const compiledDir = resolve(process.cwd(), "dist", "browser", "extension");
  const outputDir = resolve(process.cwd(), "dist", "browser-extension");
  await mkdir(outputDir, { recursive: true });

  await Promise.all([
    copyFile(
      resolve(compiledDir, "serviceWorker.js"),
      resolve(outputDir, "serviceWorker.js"),
    ),
    copyFile(
      resolve(compiledDir, "pageConversationController.js"),
      resolve(outputDir, "pageConversationController.js"),
    ),
    copyFile(
      resolve(compiledDir, "pageConversationProjection.js"),
      resolve(outputDir, "pageConversationProjection.js"),
    ),
    copyFile(
      resolve(compiledDir, "pageConversationStore.js"),
      resolve(outputDir, "pageConversationStore.js"),
    ),
    copyFile(
      resolve(compiledDir, "sidePanel.js"),
      resolve(outputDir, "sidePanel.js"),
    ),
    copyFile(
      resolve(compiledDir, "snapshotProducer.js"),
      resolve(outputDir, "snapshotProducer.js"),
    ),
    writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(browserExtensionManifest(), null, 2)}\n`, "utf8"),
    writeFile(resolve(outputDir, "sidePanel.html"), sidePanelHtml(), "utf8"),
  ]);
}

export function browserExtensionManifest(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "Forgelet Browser Context",
    version: "0.1.0",
    description: "Share the current page with Forgelet as read-only context.",
    permissions: ["activeTab", "scripting", "contextMenus", "nativeMessaging", "sidePanel", "storage"],
    action: {
      default_title: "Summarize current page",
    },
    side_panel: { default_path: "sidePanel.html" },
    background: {
      service_worker: "serviceWorker.js",
      type: "module",
    },
  };
}

export function sidePanelHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Forgelet Browser Workbench</title>
    <style>
      :root {
        --bg: #14181d;
        --fg: #e6e9ed;
        --muted: #9aa4b2;
        --surface: #1c2229;
        --surface-raised: #222a33;
        --border: #2b333d;
        --accent: #6ea8fe;
        --danger: #e5687a;
        --content-font-size: 13px;
      }
      body[data-font-size="small"] { --content-font-size: 12px; }
      body[data-font-size="medium"] { --content-font-size: 13px; }
      body[data-font-size="large"] { --content-font-size: 15px; }
      body[data-font-size="xlarge"] { --content-font-size: 17px; }
      html, body {
        height: 100%;
      }
      body {
        min-width: 320px;
        margin: 0;
        display: flex;
        flex-direction: column;
        font-family: system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        color: var(--fg);
        background: var(--bg);
      }
      .panel-header {
        flex: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 14px;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .brand-dot {
        flex: none;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--accent);
      }
      .brand h1 {
        margin: 0;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      button {
        flex: none;
        padding: 5px 14px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: transparent;
        color: var(--fg);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      button:hover {
        border-color: var(--danger);
        color: var(--danger);
      }
      #workbench-root {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        font-size: var(--content-font-size);
      }
      .status-line {
        color: var(--muted);
        font-size: 0.92em;
        margin-bottom: 10px;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 8px 0;
        font-size: 0.92em;
        line-height: 1.45;
      }
      pre.stream {
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--surface);
        padding: 10px;
        min-height: 2em;
      }
      h2 {
        font-size: 0.85em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
        margin: 18px 0 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--border);
      }
      h2:first-of-type {
        margin-top: 12px;
      }
      ul {
        margin: 4px 0;
        padding-left: 18px;
      }
      li {
        margin: 2px 0;
      }
      p {
        margin: 4px 0;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      details {
        margin-top: 16px;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 6px 10px;
        background: var(--surface);
      }
      summary {
        color: var(--muted);
        cursor: pointer;
        font-size: 0.92em;
      }
      .panel-settings {
        flex: none;
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        align-items: end;
        gap: 10px;
        padding: 10px 14px 12px;
        border-top: 1px solid var(--border);
        background: var(--surface);
      }
      label {
        display: block;
        color: var(--muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 4px;
      }
      .panel-settings .toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
      }
      .panel-settings .toggle label {
        margin-bottom: 0;
      }
      #debug:focus-visible {
        outline: 1px solid var(--accent);
        outline-offset: 1px;
      }
      select {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-raised);
        color: var(--fg);
        font: inherit;
        font-size: 12px;
      }
      select:focus-visible,
      button:focus-visible {
        outline: 1px solid var(--accent);
        outline-offset: 1px;
      }
      .composer {
        flex: none;
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 10px 14px;
        border-top: 1px solid var(--border);
        background: var(--surface);
      }
      #question {
        flex: 1;
        resize: vertical;
        min-height: 2.4em;
        max-height: 8em;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface-raised);
        color: var(--fg);
        font: inherit;
        font-size: var(--content-font-size);
      }
      #question:focus-visible,
      #send:focus-visible {
        outline: 1px solid var(--accent);
        outline-offset: 1px;
      }
      #send:disabled,
      #question:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    </style>
  </head>
  <body data-font-size="medium">
    <header class="panel-header">
      <div class="brand">
        <span class="brand-dot"></span>
        <h1>Forgelet Workbench</h1>
      </div>
      <button id="stop" type="button">Stop</button>
    </header>
    <main id="workbench-root"></main>
    <div class="composer">
      <textarea id="question" rows="1" placeholder="Ask a question about this page…" disabled></textarea>
      <button id="send" type="button" disabled>Send</button>
    </div>
    <footer class="panel-settings">
      <div>
        <label for="output-language">Output language</label>
        <select id="output-language">
          <option value="auto">Auto</option>
          <option value="en">English</option>
          <option value="zh-CN">中文</option>
        </select>
      </div>
      <div>
        <label for="font-size">Text size</label>
        <select id="font-size">
          <option value="small">Small</option>
          <option value="medium" selected>Medium</option>
          <option value="large">Large</option>
          <option value="xlarge">Extra large</option>
        </select>
      </div>
      <div class="toggle">
        <input type="checkbox" id="debug">
        <label for="debug">Debug</label>
      </div>
    </footer>
    <script type="module" src="sidePanel.js"></script>
  </body>
</html>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildBrowserExtension().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
