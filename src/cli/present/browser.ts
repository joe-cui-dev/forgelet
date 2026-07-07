import type { LoadedBrowserSnapshot } from "../../browser/index.js";

export function formatBrowserSnapshot(snapshot: LoadedBrowserSnapshot): string {
  return [
    "Browser Context Snapshot",
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Captured at: ${snapshot.capturedAt}`,
    `Content: ${snapshot.contentKind}`,
    `Content bytes: ${snapshot.contentBytes}`,
    `Content hash: ${snapshot.contentHash}`,
    `Preview: ${snapshot.preview}`,
    ...(snapshot.screenshotPath ? [`Screenshot path: ${snapshot.screenshotPath}`] : []),
  ].join("\n");
}

export function formatInstalledChromeNativeHost(input: {
  manifestPath: string;
  hostPath: string;
  extensionId: string;
}): string {
  return [
    "Chrome Native Messaging host installed",
    `Extension id: ${input.extensionId}`,
    `Manifest: ${input.manifestPath}`,
    `Host: ${input.hostPath}`,
  ].join("\n");
}
