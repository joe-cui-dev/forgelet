import { mkdir, appendFile, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { sessionTraceFileName } from "../fileNames/index.js";
import type { TraceEvent } from "../types.js";

export type { TraceEvent } from "../types.js";

export interface TraceWriter {
  readonly tracePath: string;
  append(event: TraceEvent): Promise<void>;
}

export function sessionTracePath(workspaceRoot: string, sessionId: string): string {
  return join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`);
}

export async function createTraceWriter(
  workspaceRoot: string,
  sessionId: string,
  input: { createdAt?: Date } = {},
): Promise<TraceWriter> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  const tracePath = join(
    sessionDir,
    sessionTraceFileName(sessionId, input.createdAt ?? new Date()),
  );
  await mkdir(sessionDir, { recursive: true });
  return {
    tracePath,
    async append(event: TraceEvent): Promise<void> {
      await appendFile(tracePath, `${JSON.stringify(event)}\n`, "utf8");
    }
  };
}

export function openExistingTraceWriter(tracePath: string): TraceWriter {
  return {
    tracePath,
    async append(event: TraceEvent): Promise<void> {
      await appendFile(tracePath, `${JSON.stringify(event)}\n`, "utf8");
    },
  };
}

export async function findSessionTracePath(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const legacyPath = sessionTracePath(workspaceRoot, sessionId);
  if (await exists(legacyPath)) return legacyPath;

  const matches = (await listSessionTraceFiles(workspaceRoot))
    .filter((tracePath) => basename(tracePath).endsWith(`_${sessionId}.jsonl`))
    .sort();
  return matches.at(-1) ?? legacyPath;
}

export async function readTraceFile(tracePath: string): Promise<TraceEvent[]> {
  const content = await readFile(tracePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

export async function listSessionTraceFiles(workspaceRoot: string): Promise<string[]> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  try {
    const entries = await readdir(sessionDir);
    return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(sessionDir, entry));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}
