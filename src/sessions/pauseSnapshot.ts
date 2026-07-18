import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentPlan,
  BudgetLimits,
  CreativeInputKind,
  CreativeStyle,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import type { EffectEnvelope } from "../permissions/envelope.js";
import type { ActLoopRoute, ReactNodeWorkingState } from "../kernel/reactNode.js";

const PAUSE_SNAPSHOT_VERSION = 2;

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
  limits: BudgetLimits;
  debug: boolean;
  working: ReactNodeWorkingState;
  tracePath: string;
  pausedAt: string;
}

interface SerializedWorkingSessionState {
  baselineDirtyPaths: string[];
  continuationOwnedDirtyPaths?: string[];
  forgeletTouchedPaths: string[];
}

type SerializedPauseSnapshot = Omit<PauseSnapshot, "working"> & {
  version: number;
  working: Omit<ReactNodeWorkingState, "sessionState"> & {
    sessionState: SerializedWorkingSessionState;
  };
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
    working: {
      ...snapshot.working,
      sessionState: {
        baselineDirtyPaths: [...snapshot.working.sessionState.baselineDirtyPaths],
        ...(snapshot.working.sessionState.continuationOwnedDirtyPaths
        ? {
            continuationOwnedDirtyPaths: [
                ...snapshot.working.sessionState.continuationOwnedDirtyPaths,
            ],
          }
        : {}),
        forgeletTouchedPaths: [...snapshot.working.sessionState.forgeletTouchedPaths],
      },
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
  const { version, working, ...rest } = parsed as SerializedPauseSnapshot;
  const { maxInputTokens: _retiredInputTokenBudget, ...limits } = rest.limits as BudgetLimits & {
    maxInputTokens?: unknown;
  };
  return {
    ...rest,
    limits,
    working: {
      ...working,
      usage: { ...working.usage, unpricedTurns: working.usage.unpricedTurns ?? 0 },
      sessionState: {
        baselineDirtyPaths: new Set(working.sessionState.baselineDirtyPaths),
        ...(working.sessionState.continuationOwnedDirtyPaths
        ? {
            continuationOwnedDirtyPaths: new Set(
                working.sessionState.continuationOwnedDirtyPaths,
            ),
          }
        : {}),
        forgeletTouchedPaths: new Set(working.sessionState.forgeletTouchedPaths),
      },
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
