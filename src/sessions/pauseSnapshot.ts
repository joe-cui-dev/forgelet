import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentPlan,
  BudgetLimits,
  BudgetUsage,
  CreativeInputKind,
  CreativeStyle,
  ModelMessage,
  ModelToolCall,
  ToolObservation,
  ToolRequest,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import type { RollingSummaryState } from "../conversation/fold.js";
import type { EffectEnvelope } from "../permissions/envelope.js";
import type { ActLoopRoute } from "../kernel/reactNode.js";

const PAUSE_SNAPSHOT_VERSION = 1;

export interface PauseSnapshotAuditState {
  changedFiles: string[];
  commands: { command: string; exitCode: number | null; timedOut: boolean }[];
}

export interface PauseSnapshotSessionState {
  baselineDirtyPaths: Set<string>;
  continuationOwnedDirtyPaths?: Set<string>;
  forgeletTouchedPaths: Set<string>;
}

export interface PauseSnapshot {
  sessionId: string;
  workflow: WorkflowKind;
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  creativeInputKind?: CreativeInputKind;
  task: string;
  taskHash: string;
  createdAt: string;
  envelope: EffectEnvelope;
  route: ActLoopRoute;
  readScope?: string[];
  plan: AgentPlan;
  conversation: ModelMessage[];
  rollingSummary?: RollingSummaryState;
  failedFoldAttempts: number;
  usage: BudgetUsage;
  activeWallClockMs: number;
  limits: BudgetLimits;
  turnIndex: number;
  audit: PauseSnapshotAuditState;
  sessionState: PauseSnapshotSessionState;
  debug: boolean;
  pendingToolCall: ModelToolCall;
  pendingToolRequest: ToolRequest;
  remainingToolCalls: ModelToolCall[];
  executedObservations: ToolObservation[];
  tracePath: string;
  pausedAt: string;
}

interface SerializedPauseSnapshotSessionState {
  baselineDirtyPaths: string[];
  continuationOwnedDirtyPaths?: string[];
  forgeletTouchedPaths: string[];
}

type SerializedPauseSnapshot = Omit<PauseSnapshot, "sessionState"> & {
  version: number;
  sessionState: SerializedPauseSnapshotSessionState;
};

export function pauseSnapshotPath(
  workspaceRoot: string,
  sessionId: string,
): string {
  return join(
    workspaceRoot,
    ".forgelet",
    "sessions",
    "paused",
    `${sessionId}.json`,
  );
}

export async function writePauseSnapshot(
  workspaceRoot: string,
  snapshot: PauseSnapshot,
): Promise<void> {
  const path = pauseSnapshotPath(workspaceRoot, snapshot.sessionId);
  await mkdir(join(workspaceRoot, ".forgelet", "sessions", "paused"), {
    recursive: true,
  });
  const serialized: SerializedPauseSnapshot = {
    ...snapshot,
    version: PAUSE_SNAPSHOT_VERSION,
    sessionState: {
      baselineDirtyPaths: [...snapshot.sessionState.baselineDirtyPaths],
      ...(snapshot.sessionState.continuationOwnedDirtyPaths
        ? {
            continuationOwnedDirtyPaths: [
              ...snapshot.sessionState.continuationOwnedDirtyPaths,
            ],
          }
        : {}),
      forgeletTouchedPaths: [...snapshot.sessionState.forgeletTouchedPaths],
    },
  };
  await writeFile(path, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
}

export async function readPauseSnapshot(
  workspaceRoot: string,
  sessionId: string,
): Promise<PauseSnapshot> {
  const path = pauseSnapshotPath(workspaceRoot, sessionId);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error(`Pause Snapshot not found for Session: ${sessionId} (${path}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`Pause Snapshot is not valid JSON: ${sessionId} (${path}).`);
  }
  if (!isRecord(parsed) || parsed.version !== PAUSE_SNAPSHOT_VERSION)
    throw new Error(
      `Pause Snapshot version mismatch for Session ${sessionId}: expected ${PAUSE_SNAPSHOT_VERSION}, got ${
        isRecord(parsed) ? String(parsed.version) : "unknown"
      }.`,
    );
  const { version, sessionState, ...rest } = parsed as SerializedPauseSnapshot;
  const { maxInputTokens: _retiredInputTokenBudget, ...limits } = rest.limits as BudgetLimits & {
    maxInputTokens?: unknown;
  };
  return {
    ...rest,
    usage: { ...rest.usage, unpricedTurns: rest.usage.unpricedTurns ?? 0 },
    limits,
    sessionState: {
      baselineDirtyPaths: new Set(sessionState.baselineDirtyPaths),
      ...(sessionState.continuationOwnedDirtyPaths
        ? {
            continuationOwnedDirtyPaths: new Set(
              sessionState.continuationOwnedDirtyPaths,
            ),
          }
        : {}),
      forgeletTouchedPaths: new Set(sessionState.forgeletTouchedPaths),
    },
  } as PauseSnapshot;
}

export async function deletePauseSnapshot(
  workspaceRoot: string,
  sessionId: string,
): Promise<void> {
  const path = pauseSnapshotPath(workspaceRoot, sessionId);
  await rm(path, { force: true });
}

export async function listPauseSnapshotSessionIds(
  workspaceRoot: string,
): Promise<string[]> {
  const dir = join(workspaceRoot, ".forgelet", "sessions", "paused");
  try {
    const entries = await readdir(dir);
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
