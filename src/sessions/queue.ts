import { listPauseSnapshotSessionIds, readPauseSnapshot } from "./pauseSnapshot.js";
import { showSession } from "./index.js";

export interface PausedSessionQueueEntry {
  sessionId: string;
  task: string;
  pendingToolName: string;
  pendingTargets: string[];
  pausedAt: string;
}

/** Lists Sessions currently paused awaiting a `forge decide`. Cross-checks
 * each Pause Snapshot against the Trace's derived status so a stale snapshot
 * left behind by an out-of-band trace edit never shows up as still paused. */
export async function listPausedSessions(
  workspaceRoot: string,
): Promise<PausedSessionQueueEntry[]> {
  const sessionIds = await listPauseSnapshotSessionIds(workspaceRoot);
  const entries: PausedSessionQueueEntry[] = [];

  for (const sessionId of sessionIds) {
    const snapshot = await readPauseSnapshot(workspaceRoot, sessionId).catch(
      () => undefined,
    );
    if (!snapshot) continue;
    const detail = await showSession(workspaceRoot, sessionId).catch(
      () => undefined,
    );
    if (!detail || detail.status !== "paused") continue;
    entries.push({
      sessionId,
      task: snapshot.task,
      pendingToolName: snapshot.pendingToolCall.name,
      pendingTargets: (snapshot.pendingToolRequest.targets ?? []).map(
        (target) => (target.kind === "path" ? target.path : target.command),
      ),
      pausedAt: snapshot.pausedAt,
    });
  }

  return entries.sort((left, right) => right.pausedAt.localeCompare(left.pausedAt));
}
