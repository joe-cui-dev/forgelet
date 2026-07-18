import type { ToolObservation } from "../observation/index.js";
import type {
  BudgetUsage,
  ModelMessage,
  ModelToolCall,
  ToolRequest,
} from "../types.js";
import type { RollingSummaryState } from "../conversation/index.js";

/** The complete resumable working state for a ReAct Node. This stays flat so
 * the kernel owns one shape for an in-memory run, a paused result, and a Pause
 * Snapshot rather than translating among near-identical mirrors. */
export interface ReactNodeWorkingState {
  conversation: ModelMessage[];
  rollingSummary?: RollingSummaryState;
  failedFoldAttempts: number;
  usage: BudgetUsage;
  activeWallClockMs: number;
  turnIndex: number;
  audit: {
    changedFiles: string[];
    commands: { command: string; exitCode: number | null; timedOut: boolean }[];
  };
  sessionState: ReactNodePausedSessionState;
  pendingToolCall: ModelToolCall;
  pendingToolRequest: ToolRequest;
  remainingToolCalls: ModelToolCall[];
  executedObservations: ToolObservation[];
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

export type SerializedWorkingState = Omit<
  ReactNodeWorkingState,
  "sessionState"
> & {
  sessionState: SerializedWorkingSessionState;
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
