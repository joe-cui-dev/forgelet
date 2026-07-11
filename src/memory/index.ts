import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { explainSession } from "../explain/index.js";
import { loadConfig } from "../config/index.js";
import type { MemorySuggestion } from "../types.js";

const MEMORY_SUGGESTIONS_FILE = "memory-suggestions.jsonl";
const DURABLE_MEMORY_PROMPT_LIMIT_BYTES = 20 * 1024;

export interface LoadedDurableMemory {
  path: string;
  contentBytes: number;
  returnedBytes: number;
  contentHash: string;
  preview: string;
  truncated: boolean;
  content: string;
}

export async function loadDurableMemory(
  workspaceRoot: string,
): Promise<LoadedDurableMemory | undefined> {
  const config = await loadConfig({ workspaceRoot });
  const memoryPath = resolveMemoryFile(workspaceRoot, config.memoryFile);
  try {
    const content = await readFile(memoryPath, "utf8");
    const contentBytes = Buffer.byteLength(content, "utf8");
    const returnedBytes = Math.min(
      contentBytes,
      DURABLE_MEMORY_PROMPT_LIMIT_BYTES,
    );
    const returnedContent = Buffer.from(content, "utf8")
      .subarray(0, returnedBytes)
      .toString("utf8");
    return {
      path: config.memoryFile,
      contentBytes,
      returnedBytes,
      contentHash: createHash("sha256").update(content).digest("hex"),
      preview: makePreview(returnedContent),
      truncated: returnedBytes < contentBytes,
      content: returnedContent,
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function suggestMemoryFromSession(
  workspaceRoot: string,
  sessionId: string,
): Promise<MemorySuggestion> {
  const explanation = await explainSession(workspaceRoot, sessionId);
  if (!explanation.audit)
    throw new Error(`Session does not contain actionable audit evidence: ${sessionId}`);

  const successfulCommands = explanation.audit.verificationCommands
    .filter((command) => command.exitCode === 0 && !command.timedOut)
    .map((command) => command.command);
  const changedFiles = explanation.audit.changeGroups.forgeletChanged;
  if (changedFiles.length === 0 && successfulCommands.length === 0)
    throw new Error(`Session did not produce a high-confidence memory suggestion: ${sessionId}`);

  const suggestion: MemorySuggestion = {
    id: `mem_${Date.now().toString(36)}`,
    sourceSessionId: sessionId,
    text: formatActionableAuditMemory(changedFiles, successfulCommands),
    reason:
      "Derived deterministically from actionable Session audit evidence.",
    status: "proposed",
  };

  await appendMemorySuggestion(workspaceRoot, suggestion);
  return suggestion;
}

function formatActionableAuditMemory(
  changedFiles: string[],
  successfulCommands: string[],
): string {
  const fileText = changedFiles.length > 0
    ? `after changing ${changedFiles.join(", ")}`
    : "after an actionable coding Session";
  const commandText = successfulCommands.length > 0
    ? `, use ${successfulCommands.join(", ")} as verification.`
    : ".";
  return `In this workspace, ${fileText}${commandText}`;
}

async function appendMemorySuggestion(
  workspaceRoot: string,
  suggestion: MemorySuggestion,
): Promise<void> {
  const forgeletDir = join(workspaceRoot, ".forgelet");
  await mkdir(forgeletDir, { recursive: true });
  await appendFile(
    join(forgeletDir, MEMORY_SUGGESTIONS_FILE),
    `${JSON.stringify(suggestion)}\n`,
    "utf8",
  );
}

function resolveMemoryFile(workspaceRoot: string, memoryFile: string): string {
  return isAbsolute(memoryFile) ? memoryFile : join(workspaceRoot, memoryFile);
}

function makePreview(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
