import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BrowserSnapshotContentKind } from "./index.js";

// captureId names a file inside the workspace, so it must never carry path
// separators or hidden-file prefixes even though the extension sends UUIDs.
const SAFE_CAPTURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface BrowserWorkbenchCapture {
  captureId: string;
  url: string;
  title: string;
  capturedAt: string;
  contentKind: BrowserSnapshotContentKind;
  contentHash: string;
  contentBytes: number;
  truncated: boolean;
  content: string;
}

export function isSafeCaptureId(captureId: string): boolean {
  return SAFE_CAPTURE_ID.test(captureId);
}

export function browserCapturePath(workspaceRoot: string, captureId: string): string {
  if (!isSafeCaptureId(captureId)) {
    throw new Error(`Browser capture has an unsafe captureId: ${captureId}`);
  }
  return join(workspaceRoot, ".forgelet", "browser", `${captureId}.json`);
}

/** Persists the full Workbench capture so the Trace's preview-and-hash
 * Context Attachment evidence stays verifiable against real content. */
export async function persistBrowserWorkbenchCapture(input: {
  workspaceRoot: string;
  capture: BrowserWorkbenchCapture;
}): Promise<string> {
  const capturePath = browserCapturePath(input.workspaceRoot, input.capture.captureId);
  await mkdir(dirname(capturePath), { recursive: true });
  const tempPath = `${capturePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(input.capture, null, 2)}\n`, "utf8");
  await rename(tempPath, capturePath);
  return capturePath;
}
