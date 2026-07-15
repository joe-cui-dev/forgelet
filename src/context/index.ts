import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ContextAttachment, LoadedContextAttachment } from "../types.js";
import type { SessionSourceLedger } from "../sourceLedger/index.js";

export type { ContextAttachment, LoadedContextAttachment } from "../types.js";

const supportedMimeTypes: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json"
};

export async function loadContextAttachments(
  workspaceRoot: string,
  contextFiles: string[],
  options: { sourceLedger?: SessionSourceLedger } = {},
): Promise<LoadedContextAttachment[]> {
  const attachments: LoadedContextAttachment[] = [];

  for (let index = 0; index < contextFiles.length; index += 1) {
    const filePath = contextFiles[index] ?? "";
    const resolvedPath = resolveContextPath(workspaceRoot, filePath);
    const extension = extname(resolvedPath).toLowerCase();
    const mimeType = supportedMimeTypes[extension];
    if (!mimeType) {
      throw new Error(`Unsupported context file type: ${extension || "(none)"}`);
    }

    const content = await readFile(resolvedPath, "utf8");
    const attachment: ContextAttachment = {
      id: options.sourceLedger?.nextContextId() ?? `ctx_${index + 1}`,
      source: "file",
      title: basename(filePath),
      uri: filePath,
      mimeType,
      contentBytes: Buffer.byteLength(content, "utf8"),
      contentHash: createHash("sha256").update(content).digest("hex"),
      preview: makePreview(content),
      trustLevel: isInsideWorkspace(workspaceRoot, resolvedPath) ? "workspace" : "user-provided"
    };
    const loaded = { attachment, content };
    options.sourceLedger?.append(loaded);
    attachments.push(loaded);
  }

  return attachments;
}

function resolveContextPath(workspaceRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(workspaceRoot, filePath);
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function isInsideWorkspace(workspaceRoot: string, filePath: string): boolean {
  const relativePath = relative(resolve(workspaceRoot), filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}
