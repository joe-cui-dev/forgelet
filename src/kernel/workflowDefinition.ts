import type { LoadedBrowserSnapshot } from "../browser/index.js";
import type { EffectEnvelope } from "../permissions/envelope.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { SessionSourceLedger, SessionSourceLedgerView } from "../sourceLedger/index.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";
import type { PublicWebAdapters } from "../publicWeb/index.js";
import type {
  AgentSession,
  Capability,
  CreativeInputKind,
  CreativeStyle,
  LoadedContextAttachment,
  ModelClient,
  ToolDefinition,
  WorkflowKind,
  WorkflowVariant,
} from "../types.js";
import type { TraceEventPayloads, TraceEventType } from "../trace/index.js";

/** A closed execution policy the launcher/Kernel owns, not a caller-supplied
 * budget trick. "answer_once" runs exactly one model turn with no tool
 * schemas offered, distinct from `maxModelTurns` happening to equal 1. */
export type ExecutionPolicy = "iterative" | "answer_once";

export interface AttachmentLoadPlan {
  continuationAttachment?: LoadedContextAttachment;
  contextAttachments: LoadedContextAttachment[];
}

export interface CompletionEffects<TCompletion> {
  summaryLines?: string[];
  finalSummaryTraceExtras?: Pick<
    TraceEventPayloads["final_summary"],
    "writingArtifact" | "finalContent"
  >;
  completion?: TCompletion;
}

export type AppendTrace = <Type extends TraceEventType>(
  type: Type,
  payload: TraceEventPayloads[Type],
) => Promise<void>;

export interface ActionableToolDeps {
  safeCommands: string[];
  commandTimeoutMs: number;
  maxPatchBytes: number;
  sessionState: {
    baselineDirtyPaths: Set<string>;
    continuationOwnedDirtyPaths?: Set<string>;
    forgeletTouchedPaths: Set<string>;
  };
}

export interface WorkflowDefinition<TCompletion = void> {
  readonly kind: WorkflowKind;
  readonly sessionTraits?: {
    workflowVariant?: WorkflowVariant;
    creativeStyle?: CreativeStyle;
    creativeInputKind?: CreativeInputKind;
    startTraceExtras?: Pick<
      TraceEventPayloads["session_started"],
      "projectSlug" | "deliverableShape" | "trigger"
    >;
  };

  loadAttachments(ctx: {
    workspaceRoot: string;
    contextFiles: string[];
    sourceLedger: SessionSourceLedger;
  }): Promise<AttachmentLoadPlan>;

  capabilities(ctx: { act: boolean; readScope?: string[] }): Capability[];

  createActionableTools?(deps: ActionableToolDeps): ToolDefinition[];

  offersTools?(ctx: {
    continuationAttachment?: LoadedContextAttachment;
    contextAttachments: readonly LoadedContextAttachment[];
  }): boolean;

  systemPrompt(ctx: { act: boolean }): string;

  taskLabel?(): string;

  promptContextLines?(): string[];

  normalizeFinalContent?(
    content: string,
    ctx: {
      contextAttachments: readonly LoadedContextAttachment[];
      sourceLedger?: SessionSourceLedgerView;
    },
  ): string;

  onCompleted?(ctx: {
    workspaceRoot: string;
    session: AgentSession;
    finalContent: string;
    contextAttachments: readonly LoadedContextAttachment[];
    sourceLedger?: SessionSourceLedgerView;
    appendTrace: AppendTrace;
  }): Promise<CompletionEffects<TCompletion> | undefined>;
}

export interface RunKernelSessionInput<TCompletion = void> {
  definition: WorkflowDefinition<TCompletion>;
  task: string;
  contextFiles: string[];
  browserSnapshot?: LoadedBrowserSnapshot;
  publicWeb?: PublicWebAdapters;
  readScopeRequest?: string[];
  model?: string;
  budgetUsd?: number;
  maxWallClockMs?: number;
  maxModelTurns?: number;
  homeDir?: string;
  workspaceRoot: string;
  modelClient?: ModelClient;
  act?: boolean;
  debug?: boolean;
  executionPolicy?: ExecutionPolicy;
  continuationSourceSessionId?: string;
  approvalHandler?: ApprovalHandler;
  envelope?: EffectEnvelope;
  /** Injectable clock for deterministic wall-clock budget tests; defaults to Date.now. */
  now?: () => number;
  onLiveEvent?: SessionLiveEventSink;
  /** The only user cancellation path. Checked before Session creation, before
   * each model attempt, before retries, and before completion effects; only
   * this owned signal converts to `user_stopped` (ADR 0039 WP4). */
  signal?: AbortSignal;
}

export interface KernelSessionResult<TCompletion = void> {
  session: AgentSession;
  summary: string;
  tracePath: string;
  completion?: TCompletion;
  status?: "paused";
  snapshotPath?: string;
}
