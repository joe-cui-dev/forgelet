import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/** Reloads a persisted Workbench capture verbatim, without verifying its
 * identity or content hash: callers that need integrity guarantees (Page
 * Conversation follow-up preflight, WP7) must verify the result themselves.
 * Throws on a missing or unparseable file. */
export async function readBrowserWorkbenchCapture(
  workspaceRoot: string,
  captureId: string,
): Promise<BrowserWorkbenchCapture> {
  const capturePath = browserCapturePath(workspaceRoot, captureId);
  const raw = await readFile(capturePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!isBrowserWorkbenchCapture(parsed))
    throw new Error(`Persisted browser capture is malformed: ${captureId}`);
  return parsed;
}

function isBrowserWorkbenchCapture(
  value: unknown,
): value is BrowserWorkbenchCapture {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.captureId === "string" &&
    typeof record.url === "string" &&
    typeof record.title === "string" &&
    typeof record.capturedAt === "string" &&
    (record.contentKind === "selectedText" || record.contentKind === "mainText") &&
    typeof record.contentHash === "string" &&
    typeof record.contentBytes === "number" &&
    typeof record.truncated === "boolean" &&
    typeof record.content === "string"
  );
}
