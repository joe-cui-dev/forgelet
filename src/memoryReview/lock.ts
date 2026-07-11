import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isProcessAlive } from "../sessions/pidMarker.js";
import { hasErrorCode } from "./records.js";

const LOCK_RELATIVE_PATH = ".forgelet/memory-decisions.lock";
const RETRY_DELAY_MS = 25;
const TIMEOUT_MS = 5_000;

/** One advisory lock serializes every Memory Decision Log append (ADR 0035:
 * the log append is the commit point). A lock file naming a dead process is
 * stale and taken over, so a crashed CLI never wedges later commands. */
export async function withMemoryDecisionLock<T>(
  workspaceRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = join(workspaceRoot, LOCK_RELATIVE_PATH);
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      const holder = await readLockHolder(lockPath);
      if (holder !== undefined && !isProcessAlive(holder)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `Timed out waiting for the memory decision lock: ${LOCK_RELATIVE_PATH}`,
        );
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

async function readLockHolder(lockPath: string): Promise<number | undefined> {
  try {
    const pid = Number((await readFile(lockPath, "utf8")).trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
