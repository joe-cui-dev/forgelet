import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ContextAttachment, LoadedContextAttachment } from "../types.js";

export interface SessionSourceLedgerView {
  contextAttachments(): readonly LoadedContextAttachment[];
}

export interface SessionSourceLedger {
  readonly view: SessionSourceLedgerView;
  nextContextId(): string;
  append(attachment: LoadedContextAttachment): void;
  appendWebSource(input: WebSourceInput): Promise<WebSourceAppendResult>;
  takePendingWebSources(): LoadedContextAttachment[];
}

export interface WebSourceInput {
  title: string;
  url: string;
  finalUrl: string;
  content: string;
  fetchedBytes: number;
  contentType: string;
}

export interface WebSourceAppendResult {
  attachment: LoadedContextAttachment;
  deduplicated: boolean;
}

/** Owns the stable source identity sequence for one Session. */
export function createSessionSourceLedger(input: {
  workspaceRoot?: string;
  sessionId?: string;
} = {}): SessionSourceLedger {
  const attachments: LoadedContextAttachment[] = [];
  const pendingWebSources: LoadedContextAttachment[] = [];

  return {
    view: { contextAttachments: () => attachments },
    nextContextId: () => `ctx_${attachments.length + 1}`,
    append: (attachment) => {
      const expectedId = `ctx_${attachments.length + 1}`;
      if (attachment.attachment.id !== expectedId)
        throw new Error(
          `Session source identity must be ${expectedId}, received ${attachment.attachment.id}.`,
        );
      attachments.push(attachment);
    },
    async appendWebSource(webSource) {
      const contentHash = createHash("sha256").update(webSource.content).digest("hex");
      const canonicalUrl = canonicalizeUrl(webSource.finalUrl);
      const existing = attachments.find(
        ({ attachment }) =>
          attachment.source === "web" &&
          attachment.uri === canonicalUrl &&
          attachment.contentHash === contentHash,
      );
      if (existing) return { attachment: existing, deduplicated: true };

      const id = `ctx_${attachments.length + 1}`;
      const contentPath = input.workspaceRoot && input.sessionId
        ? await persistWebSource(input.workspaceRoot, input.sessionId, id, {
            title: webSource.title,
            url: webSource.url,
            finalUrl: webSource.finalUrl,
            canonicalUrl,
            content: webSource.content,
            contentHash,
            contentType: webSource.contentType,
            fetchedBytes: webSource.fetchedBytes,
          })
        : undefined;
      const attachment: ContextAttachment = {
        id,
        source: "web",
        title: webSource.title,
        uri: canonicalUrl,
        mimeType: "text/plain",
        contentBytes: Buffer.byteLength(webSource.content, "utf8"),
        contentHash,
        preview: makePreview(webSource.content),
        ...(contentPath ? { contentPath } : {}),
        trustLevel: "external",
      };
      const loaded = { attachment, content: webSource.content };
      attachments.push(loaded);
      pendingWebSources.push(loaded);
      return { attachment: loaded, deduplicated: false };
    },
    takePendingWebSources: () => pendingWebSources.splice(0),
  };
}

function canonicalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

async function persistWebSource(
  workspaceRoot: string,
  sessionId: string,
  id: string,
  value: Record<string, unknown>,
): Promise<string> {
  const absolutePath = join(workspaceRoot, ".forgelet", "web", sessionId, `${id}.json`);
  await mkdir(dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8");
  await rename(temporaryPath, absolutePath);
  return join(".forgelet", "web", sessionId, `${id}.json`);
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}
