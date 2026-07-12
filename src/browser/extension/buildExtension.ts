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

function sidePanelHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Forgelet Browser Workbench</title>
    <style>
      body {
        min-width: 320px;
        margin: 0;
        padding: 12px;
        font-family: system-ui, sans-serif;
        color: #17202a;
        background: #ffffff;
      }
      button {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #9aa4b2;
        border-radius: 6px;
        background: #f7f9fb;
        color: #17202a;
        font: inherit;
        cursor: pointer;
      }
      pre {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        margin: 12px 0 0;
        font-size: 12px;
        line-height: 1.4;
      }
    </style>
  </head>
  <body>
    <button id="stop" type="button">Stop</button>
    <pre id="workbench-output"></pre>
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
