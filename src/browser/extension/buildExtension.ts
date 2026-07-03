import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function buildBrowserExtension(): Promise<void> {
  const compiledDir = resolve(process.cwd(), "dist", "browser", "extension");
  const outputDir = resolve(process.cwd(), "dist", "browser-extension");
  await mkdir(outputDir, { recursive: true });

  await Promise.all([
    copyFile(
      resolve(compiledDir, "serviceWorker.js"),
      resolve(outputDir, "serviceWorker.js"),
    ),
    copyFile(
      resolve(compiledDir, "popup.js"),
      resolve(outputDir, "popup.js"),
    ),
    copyFile(
      resolve(compiledDir, "snapshotProducer.js"),
      resolve(outputDir, "snapshotProducer.js"),
    ),
    writeFile(resolve(outputDir, "manifest.json"), `${JSON.stringify(manifest(), null, 2)}\n`, "utf8"),
    writeFile(resolve(outputDir, "popup.html"), popupHtml(), "utf8"),
  ]);
}

function manifest(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "Forgelet Browser Context",
    version: "0.1.0",
    description: "Share the current page with Forgelet as read-only context.",
    permissions: ["activeTab", "scripting", "contextMenus", "nativeMessaging"],
    action: {
      default_title: "Share with Forgelet",
      default_popup: "popup.html",
    },
    background: {
      service_worker: "serviceWorker.js",
      type: "module",
    },
  };
}

function popupHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Forgelet</title>
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
    <button id="share-page" type="button">Share current page</button>
    <pre id="share-output"></pre>
    <script type="module" src="popup.js"></script>
  </body>
</html>
`;
}

buildBrowserExtension().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
