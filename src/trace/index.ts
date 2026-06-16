import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TraceEvent } from "../types.js";

export type { TraceEvent } from "../types.js";

export interface TraceWriter {
  readonly tracePath: string;
  append(event: TraceEvent): Promise<void>;
}

export function sessionTracePath(workspaceRoot: string, sessionId: string): string {
  return join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`);
}

export async function createTraceWriter(workspaceRoot: string, sessionId: string): Promise<TraceWriter> {
  const tracePath = sessionTracePath(workspaceRoot, sessionId);
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  return {
    tracePath,
    async append(event: TraceEvent): Promise<void> {
      await appendFile(tracePath, `${JSON.stringify(event)}\n`, "utf8");
    }
  };
}

export async function readTraceFile(tracePath: string): Promise<TraceEvent[]> {
  const content = await readFile(tracePath, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

export async function listSessionTraceFiles(workspaceRoot: string): Promise<string[]> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  try {
    const entries = await readdir(sessionDir);
    return entries.filter((entry) => entry.endsWith(".jsonl")).map((entry) => join(sessionDir, entry));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
