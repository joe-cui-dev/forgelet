import type { PausedSessionQueueEntry } from "../../sessions/queue.js";

export function formatQueue(entries: PausedSessionQueueEntry[]): string {
  if (entries.length === 0) return "No Sessions are paused.";
  return entries
    .map((entry) =>
      [
        `Session: ${entry.sessionId}`,
        `Task: ${entry.task}`,
        `Pending action: ${entry.pendingToolName} (${entry.pendingTargets.join(", ") || "no targets"})`,
        `Paused at: ${entry.pausedAt}`,
        `Run \`forge decide ${entry.sessionId}\` to review.`,
      ].join("\n"),
    )
    .join("\n\n");
}
