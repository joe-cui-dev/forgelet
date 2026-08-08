import { suggestMemoryFromSession, type SuggestMemoryResult } from "../../memory/index.js";
import { listSessions } from "../../sessions/index.js";
import { formatMemorySuggestion, formatMemorySuggestBatch } from "../present/memory.js";
import {
  createDeepSeekLiveModelClient,
  createDeferredLiveModelClient,
} from "../wiring.js";
import type { ModelClient } from "../../types.js";
import type { RunCliOptions } from "../index.js";

export interface MemorySuggestCommand {
  kind: "memory-suggest";
  sessionId: string;
}

export interface MemorySuggestAllCommand {
  kind: "memory-suggest-all";
  since?: number;
}

export interface MemorySuggestBatchEntry {
  sessionId: string;
  result?: SuggestMemoryResult;
  error?: string;
}

export interface MemorySuggestBatchReport {
  examined: number;
  admitted: number;
  created: number;
  existing: number;
  failed: number;
  entries: MemorySuggestBatchEntry[];
}

/** The Retrospective Session's model client, built deferred so a Session that
 * misses the Friction gate returns before a provider key is ever required. */
function retrospectiveModelClient(ctx: {
  workspaceRoot: string;
  options: RunCliOptions;
}): ModelClient {
  const { workspaceRoot, options } = ctx;
  return createDeferredLiveModelClient(
    {
      workflow: "retrospective",
      homeDir: options.homeDir,
      workspaceRoot,
      env: options.env ?? process.env,
    },
    options.createLiveModelClient ?? createDeepSeekLiveModelClient,
  );
}

/** Runs `forge memory suggest <sessionId>`: a Retrospective Session gated on
 * Friction (ADR 0075). The model client is deferred, so a Session with no
 * Friction Signal returns before a provider key is ever required. */
export async function runMemorySuggestCommand(
  command: MemorySuggestCommand,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string> {
  const { workspaceRoot, options } = ctx;
  const modelClient = retrospectiveModelClient(ctx);
  const result = await suggestMemoryFromSession(workspaceRoot, command.sessionId, {
    modelClient,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  return formatMemorySuggestion(result);
}

/** Runs `forge memory suggest --all [--since N]`: a loop over Sessions, gated
 * on Friction per Session (ADR 0075). It is a batch, not a second derivation
 * shape — each Session goes through the same single-Session path, and one
 * Session's failure never aborts the run. */
export async function runMemorySuggestBatchCommand(
  command: MemorySuggestAllCommand,
  ctx: { workspaceRoot: string; options: RunCliOptions },
): Promise<string> {
  const { workspaceRoot, options } = ctx;
  const modelClient = retrospectiveModelClient(ctx);
  const report = await suggestMemoryBatch(workspaceRoot, modelClient, {
    ...(command.since !== undefined ? { since: command.since } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  return formatMemorySuggestBatch(report);
}

/** Iterates the Sessions once (newest first), gating each on Friction, and
 * aggregates the outcomes. Exposed for tests and reuse; the CLI wraps it. */
export async function suggestMemoryBatch(
  workspaceRoot: string,
  modelClient: ModelClient,
  options: { since?: number; homeDir?: string } = {},
): Promise<MemorySuggestBatchReport> {
  // The Session list is snapshotted before the loop, so the Retrospective
  // Sessions this batch creates are not themselves examined by it.
  const sessions = await listSessions(workspaceRoot);
  const scoped = options.since !== undefined ? sessions.slice(0, options.since) : sessions;

  const report: MemorySuggestBatchReport = {
    examined: scoped.length,
    admitted: 0,
    created: 0,
    existing: 0,
    failed: 0,
    entries: [],
  };
  for (const session of scoped) {
    try {
      const result = await suggestMemoryFromSession(workspaceRoot, session.id, {
        modelClient,
        ...(options.homeDir ? { homeDir: options.homeDir } : {}),
      });
      if (!result.admitted) continue;
      report.admitted += 1;
      report.created += result.suggestions.filter((entry) => entry.outcome === "created").length;
      report.existing += result.suggestions.filter((entry) => entry.outcome === "existing").length;
      report.entries.push({ sessionId: session.id, result });
    } catch (error) {
      report.failed += 1;
      report.entries.push({
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
