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
      resolve(compiledDir, "workbench.js"),
      resolve(outputDir, "workbench.js"),
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
        --border: #2b333d;
        --accent: #6ea8fe;
      }
      body {
        min-width: 320px;
        margin: 0;
        padding: 12px;
        font-family: system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        color: var(--fg);
        background: var(--bg);
      }
      button {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--fg);
        font: inherit;
        cursor: pointer;
      }
      button:hover {
        border-color: var(--muted);
      }
      #workbench-root {
        margin-top: 12px;
      }
      .status-line {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 8px 0;
        font-size: 12px;
        line-height: 1.4;
      }
      pre.stream {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        padding: 8px;
        min-height: 2em;
      }
      h2 {
        font-size: 13px;
        margin: 14px 0 4px;
      }
      ul {
        margin: 4px 0;
        padding-left: 18px;
      }
      p {
        margin: 4px 0;
      }
      a {
        color: var(--accent);
      }
      details {
        margin-top: 14px;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 6px 8px;
      }
      summary {
        color: var(--muted);
        cursor: pointer;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <button id="stop" type="button">Stop</button>
    <div id="workbench-root"></div>
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
