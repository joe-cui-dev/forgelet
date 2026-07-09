import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function pidMarkerPath(workspaceRoot: string, sessionId: string): string {
  return join(workspaceRoot, ".forgelet", "running", `${sessionId}.pid`);
}

export async function writePidMarker(
  workspaceRoot: string,
  sessionId: string,
  pid: number = process.pid,
): Promise<void> {
  const path = pidMarkerPath(workspaceRoot, sessionId);
  await mkdir(join(workspaceRoot, ".forgelet", "running"), {
    recursive: true,
  });
  await writeFile(path, String(pid), "utf8");
}

export async function removePidMarker(
  workspaceRoot: string,
  sessionId: string,
): Promise<void> {
  await rm(pidMarkerPath(workspaceRoot, sessionId), { force: true });
}

export async function readPidMarker(
  workspaceRoot: string,
  sessionId: string,
): Promise<number | undefined> {
  try {
    const content = await readFile(pidMarkerPath(workspaceRoot, sessionId), "utf8");
    const pid = Number(content.trim());
    return Number.isInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Probes whether a pid marker names a still-live OS process. Signal 0 sends
 * nothing but throws ESRCH if the process doesn't exist, so this never
 * actually terminates anything. Injectable so status derivation can be
 * tested without touching real processes. */
export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
