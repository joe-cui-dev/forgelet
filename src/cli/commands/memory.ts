import { captureMemorySuggestions } from "../../memory/index.js";
import { listSessions, type SessionStatus } from "../../sessions/index.js";
import { formatMemoryCapture } from "../present/memory.js";
import type { RunCliOptions } from "../index.js";

export interface MemoryAddCommand {
  kind: "memory-add";
  sessionId?: string;
  text: string;
}

/** A finished Session is one whose Trace recorded `session_finished`; its
 * provenance carries a real `finishedAt`. `forge memory add` without a
 * `--session` defaults to the most recent such Session (ADR 0076). */
const FINISHED_STATUSES: ReadonlySet<SessionStatus> = new Set([
  "completed",
  "stopped",
  "failed",
]);

/** Runs `forge memory add [--session <id>] "<text>"`: the backfill path for
 * in-session capture (ADR 0076). It records one human-authored line as a Memory
 * Suggestion with the same provenance a Session-end capture would write, so a
 * user who skipped the prompt — or ran a non-TTY Session — can still add the
 * entry later. Without `--session` it targets the most recent finished Session. */
export async function runMemoryAddCommand(
  command: MemoryAddCommand,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string> {
  const { workspaceRoot } = ctx;
  const sessionId = command.sessionId ?? (await mostRecentFinishedSessionId(workspaceRoot));
  const captured = await captureMemorySuggestions(workspaceRoot, sessionId, [command.text]);
  return formatMemoryCapture(sessionId, captured);
}

async function mostRecentFinishedSessionId(workspaceRoot: string): Promise<string> {
  const sessions = await listSessions(workspaceRoot);
  const finished = sessions.find((session) => FINISHED_STATUSES.has(session.status));
  if (!finished)
    throw new Error(
      "No finished Session to attribute this memory to. Pass --session <id> to name one.",
    );
  return finished.id;
}
