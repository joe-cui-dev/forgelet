import type { LoadedBrowserSnapshot } from "../browser/index.js";
import type { SessionLiveEventSink } from "../sessionLiveView/index.js";
import type { ApprovalHandler } from "../tools/toolRegistry.js";
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

export interface AttachmentLoadPlan {
  continuationAttachment?: LoadedContextAttachment;
  contextAttachments: LoadedContextAttachment[];
}

export interface CompletionEffects<TCompletion> {
  summaryLines?: string[];
  finalSummaryTraceExtras?: Record<string, unknown>;
  completion?: TCompletion;
}

export type AppendTrace = (
  type: string,
  payload: Record<string, unknown>,
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
    startTraceExtras?: Record<string, unknown>;
  };

  loadAttachments(ctx: {
    workspaceRoot: string;
    contextFiles: string[];
  }): Promise<AttachmentLoadPlan>;

  capabilities(ctx: { act: boolean; readScope?: string[] }): Capability[];

  createActionableTools?(deps: ActionableToolDeps): ToolDefinition[];

  offersTools?(ctx: {
    continuationAttachment?: LoadedContextAttachment;
    contextAttachments: readonly LoadedContextAttachment[];
  }): boolean;

  prepareSession?(ctx: { workspaceRoot: string }): Promise<void>;

  systemPrompt(ctx: { act: boolean; finalOnly: boolean }): string;

  taskLabel?(): string;

  promptContextLines?(): string[];

  normalizeFinalContent?(
    content: string,
    ctx: { contextAttachments: readonly LoadedContextAttachment[] },
  ): string;

  onCompleted?(ctx: {
    workspaceRoot: string;
    session: AgentSession;
    finalContent: string;
    contextAttachments: readonly LoadedContextAttachment[];
    appendTrace: AppendTrace;
  }): Promise<CompletionEffects<TCompletion> | undefined>;
}

export interface RunKernelSessionInput<TCompletion = void> {
  definition: WorkflowDefinition<TCompletion>;
  task: string;
  contextFiles: string[];
  browserSnapshot?: LoadedBrowserSnapshot;
  readScopeRequest?: string[];
  model?: string;
  budgetUsd?: number;
  homeDir?: string;
  workspaceRoot: string;
  modelClient?: ModelClient;
  act?: boolean;
  debug?: boolean;
  continuationSourceSessionId?: string;
  approvalHandler?: ApprovalHandler;
  onLiveEvent?: SessionLiveEventSink;
}

export interface KernelSessionResult<TCompletion = void> {
  session: AgentSession;
  summary: string;
  tracePath: string;
  completion?: TCompletion;
}
