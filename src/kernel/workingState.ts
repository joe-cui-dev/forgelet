import type { ToolObservation } from "../observation/index.js";
import type {
  BudgetUsage,
  ModelMessage,
  ModelToolCall,
  ToolRequest,
} from "../types.js";
import type { ActiveContextCompactorState } from "../conversation/index.js";

/** The complete resumable working state for a ReAct Node. The kernel owns one
 * shape for an in-memory run, a paused result, and a Pause Snapshot rather
 * than translating among near-identical mirrors. */
export interface ReactNodeWorkingState {
  conversation: ModelMessage[];
  activeContext: ActiveContextCompactorState;
  usage: BudgetUsage;
  activeWallClockMs: number;
  turnIndex: number;
  audit: {
    changedFiles: string[];
    /** Successful `apply_patch` calls so far. Each command records the count it
     * saw, which is what lets the audit tell a verification from a command that
     * ran before the change it would have to have verified. */
    changeCount: number;
    commands: {
      command: string;
      exitCode: number | null;
      timedOut: boolean;
      changeCountWhenRun: number;
    }[];
  };
  sessionState: ReactNodePausedSessionState;
  pendingToolCall: ModelToolCall;
  pendingToolRequest: ToolRequest;
  remainingToolCalls: ModelToolCall[];
  executedObservations: ToolObservation[];
  /** One-shot Turn Status notice restored after a pause. */
  pendingTruncationNotice?: boolean;
}

export interface ReactNodePausedSessionState {
  baselineDirtyPaths: Set<string>;
  continuationOwnedDirtyPaths?: Set<string>;
  forgeletTouchedPaths: Set<string>;
}

export interface SerializedWorkingSessionState {
  baselineDirtyPaths: string[];
  continuationOwnedDirtyPaths?: string[];
  forgeletTouchedPaths: string[];
}

// The audit fields are optional on the way in because Pause Snapshots written
// before verification ordering was tracked are still resumable; see
// `deserializeWorkingState` for how they are read.
export interface SerializedWorkingAudit {
  changedFiles: string[];
  changeCount?: number;
  commands: {
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    changeCountWhenRun?: number;
  }[];
}

export type SerializedWorkingState = Omit<
  ReactNodeWorkingState,
  "sessionState" | "audit"
> & {
  sessionState: SerializedWorkingSessionState;
  audit: SerializedWorkingAudit;
};

export const serializeWorkingState = (
  working: ReactNodeWorkingState,
): SerializedWorkingState => ({
  ...working,
  sessionState: {
    baselineDirtyPaths: [...working.sessionState.baselineDirtyPaths],
    ...(working.sessionState.continuationOwnedDirtyPaths
      ? {
          continuationOwnedDirtyPaths: [
            ...working.sessionState.continuationOwnedDirtyPaths,
          ],
        }
      : {}),
    forgeletTouchedPaths: [...working.sessionState.forgeletTouchedPaths],
  },
});

export const deserializeWorkingState = (
  value: SerializedWorkingState,
): ReactNodeWorkingState => ({
  ...value,
  usage: { ...value.usage, unpricedTurns: value.usage.unpricedTurns ?? 0 },
  // A Pause Snapshot written before commands carried their change count reads
  // as "nothing has changed yet", which is the honest reading: its commands
  // predate every change the resumed run goes on to make.
  audit: {
    ...value.audit,
    changeCount: value.audit.changeCount ?? 0,
    commands: value.audit.commands.map((command) => ({
      ...command,
      changeCountWhenRun: command.changeCountWhenRun ?? 0,
    })),
  },
  sessionState: {
    baselineDirtyPaths: new Set(value.sessionState.baselineDirtyPaths),
    ...(value.sessionState.continuationOwnedDirtyPaths
      ? {
          continuationOwnedDirtyPaths: new Set(
            value.sessionState.continuationOwnedDirtyPaths,
          ),
        }
      : {}),
    forgeletTouchedPaths: new Set(value.sessionState.forgeletTouchedPaths),
  },
});
