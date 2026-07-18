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
import type { ActLoopRoute } from "../kernel/reactNode.js";
import {
  deserializeWorkingState,
  serializeWorkingState,
  type ReactNodeWorkingState,
  type SerializedWorkingState,
} from "../kernel/workingState.js";
import type { ObservationRange } from "../observation/index.js";
import type { RollingSummaryState } from "../conversation/index.js";

const PAUSE_SNAPSHOT_VERSION = 4;

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

type SerializedPauseSnapshot = Omit<PauseSnapshot, "working"> & {
  version: number;
  working: SerializedWorkingState;
};

type VersionThreeWorkingState = Omit<SerializedWorkingState, "activeContext"> & {
  rollingSummary?: RollingSummaryState;
  failedFoldAttempts?: number;
};

type VersionThreePauseSnapshot = Omit<SerializedPauseSnapshot, "working"> & {
  working: VersionThreeWorkingState;
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
    working: serializeWorkingState(snapshot.working),
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
  if (
    !isRecord(parsed) ||
    (parsed.version !== PAUSE_SNAPSHOT_VERSION &&
      parsed.version !== 3 &&
      parsed.version !== 2)
  )
    throw new Error(
      `Pause Snapshot version mismatch for Session ${sessionId}: expected ${PAUSE_SNAPSHOT_VERSION}, got ${
        isRecord(parsed) ? String(parsed.version) : "unknown"
      }.`,
    );
  const migratedFromVersionTwo: SerializedPauseSnapshot | VersionThreePauseSnapshot =
    parsed.version === 2
      ? migrateVersionTwoSnapshot(parsed as unknown as VersionThreePauseSnapshot)
      : (parsed as unknown as SerializedPauseSnapshot);
  const migrated =
    migratedFromVersionTwo.version === 3
      ? migrateVersionThreeSnapshot(
          migratedFromVersionTwo as VersionThreePauseSnapshot,
        )
      : migratedFromVersionTwo;
  const { version, working, ...rest } = migrated;
  const { maxInputTokens: _retiredInputTokenBudget, ...limits } = rest.limits as BudgetLimits & {
    maxInputTokens?: unknown;
  };
  return {
    ...rest,
    limits,
    working: deserializeWorkingState(working as SerializedWorkingState),
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

function migrateVersionTwoSnapshot(
  snapshot: VersionThreePauseSnapshot,
): VersionThreePauseSnapshot {
  const rollingSummary = snapshot.working.rollingSummary;
  if (!rollingSummary) return { ...snapshot, version: 3 };
  return {
    ...snapshot,
    version: 3,
    working: {
      ...snapshot.working,
      rollingSummary: {
        ...rollingSummary,
        ledger: {
          ...rollingSummary.ledger,
          files: rollingSummary.ledger.files.map((file) => ({
            ...file,
            ranges: (file.ranges as unknown[])
              .map(parseLegacyRange)
              .filter((range): range is ObservationRange => range !== undefined),
          })),
        },
      },
    },
  };
}

function migrateVersionThreeSnapshot(
  snapshot: VersionThreePauseSnapshot,
): SerializedPauseSnapshot {
  const { rollingSummary, failedFoldAttempts, ...working } = snapshot.working;
  return {
    ...snapshot,
    version: PAUSE_SNAPSHOT_VERSION,
    working: {
      ...working,
      activeContext: {
        ...(rollingSummary ? { rollingSummary } : {}),
        failedFoldAttempts: failedFoldAttempts ?? 0,
      },
    },
  };
}

function parseLegacyRange(value: unknown): ObservationRange | undefined {
  if (typeof value !== "string") return undefined;
  const byte = /^byte range (\d+)-(\d+)(?: of (\d+))?$/.exec(value);
  if (byte)
    return {
      kind: "byte",
      start: Number(byte[1]),
      end: Number(byte[2]),
      ...(byte[3] === undefined ? {} : { total: Number(byte[3]) }),
    };
  const line = /^line range (\d+)-(\d+)$/.exec(value);
  return line
    ? { kind: "line", start: Number(line[1]), end: Number(line[2]) }
    : undefined;
}
