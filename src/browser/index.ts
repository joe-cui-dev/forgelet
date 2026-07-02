import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LoadedContextAttachment } from "../types.js";

const BROWSER_SNAPSHOT_TTL_MS = 15 * 60 * 1000;

export type BrowserSnapshotContentKind = "selectedText" | "mainText";

export interface BrowserSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  selectedText?: string;
  mainText?: string;
  screenshotPath?: string;
}

export interface LoadedBrowserSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  contentKind: BrowserSnapshotContentKind;
  content: string;
  contentBytes: number;
  contentHash: string;
  preview: string;
  screenshotPath?: string;
}

export async function loadCurrentBrowserSnapshot(input: {
  homeDir?: string;
  now?: Date;
} = {}): Promise<LoadedBrowserSnapshot> {
  const path = currentBrowserSnapshotPath(input.homeDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        "No current browser snapshot found. Share the current page from the Forgelet browser extension, then retry.",
      );
    }
    throw error;
  }

  const snapshot = parseBrowserSnapshot(raw);
  const capturedAtMs = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAtMs)) {
    throw new Error("Browser snapshot has an invalid capturedAt timestamp.");
  }
  const ageMs = (input.now ?? new Date()).getTime() - capturedAtMs;
  if (ageMs > BROWSER_SNAPSHOT_TTL_MS) {
    throw new Error(
      "Browser snapshot is stale. Share the current page again, then retry.",
    );
  }

  const selectedText = normalizeContent(snapshot.selectedText);
  const mainText = normalizeContent(snapshot.mainText);
  const contentKind: BrowserSnapshotContentKind = selectedText
    ? "selectedText"
    : "mainText";
  const content = selectedText || mainText;
  if (!content) {
    throw new Error(
      "Browser snapshot does not contain selectedText or mainText content.",
    );
  }

  return {
    url: snapshot.url,
    title: snapshot.title,
    capturedAt: snapshot.capturedAt,
    contentKind,
    content,
    contentBytes: Buffer.byteLength(content, "utf8"),
    contentHash: createHash("sha256").update(content).digest("hex"),
    preview: makePreview(content),
    ...(snapshot.screenshotPath ? { screenshotPath: snapshot.screenshotPath } : {}),
  };
}

export function currentBrowserSnapshotPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".forgelet", "browser", "current-page.json");
}

export function browserSnapshotToContextAttachment(
  snapshot: LoadedBrowserSnapshot,
  id: string,
): LoadedContextAttachment {
  return {
    attachment: {
      id,
      source: "browser",
      title: snapshot.title,
      uri: snapshot.url,
      mimeType: "text/plain",
      contentBytes: snapshot.contentBytes,
      contentHash: snapshot.contentHash,
      preview: snapshot.preview,
      trustLevel: "external",
    },
    content: snapshot.content,
  };
}

function parseBrowserSnapshot(raw: string): BrowserSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Browser snapshot is not valid JSON.");
  }
  if (!isRecord(value)) throw new Error("Browser snapshot must be an object.");
  const url = requiredString(value, "url");
  const title = requiredString(value, "title");
  const capturedAt = requiredString(value, "capturedAt");
  return {
    url,
    title,
    capturedAt,
    ...(optionalString(value, "selectedText") !== undefined
      ? { selectedText: optionalString(value, "selectedText") }
      : {}),
    ...(optionalString(value, "mainText") !== undefined
      ? { mainText: optionalString(value, "mainText") }
      : {}),
    ...(optionalString(value, "screenshotPath") !== undefined
      ? { screenshotPath: optionalString(value, "screenshotPath") }
      : {}),
  };
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`Browser snapshot is missing ${key}.`);
  }
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (typeof field !== "string") {
    throw new Error(`Browser snapshot field ${key} must be a string.`);
  }
  return field;
}

function normalizeContent(value: string | undefined): string {
  return value?.trim() ?? "";
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
