import type { ToolObservationErrorCode } from "./observation/index.js";

export type WorkflowKind = "coding" | "writing" | "learning";

export type WorkflowVariant = "creative";
/** Style Preset names remain open to workspace-defined additions and replacements. */
export type CreativeStyle = string;
export type CreativeInputKind = "draft" | "revision" | "continuation";

export type AgentStage =
  | "intake"
  | "inspect"
  | "plan"
  | "act_loop"
  | "verify"
  | "review"
  | "final";

export type Capability =
  | "read_context"
  | "read_workspace"
  | "write_workspace"
  | "run_safe_command"
  | "git_read"
  | "read_public_web"
  | "update_plan"
  | "model_generate_text";

export interface WorkflowCapabilityGrant {
  workflow: WorkflowKind;
  capabilities: Capability[];
}

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  step: string;
  status: PlanStatus;
}

export interface AgentPlan {
  items: PlanItem[];
}

export interface AgentSession {
  id: string;
  workflow: WorkflowKind;
  workflowVariant?: WorkflowVariant;
  creativeStyle?: CreativeStyle;
  creativeInputKind?: CreativeInputKind;
  task: string;
  taskHash: string;
  readScope?: string[];
  stage: AgentStage;
  plan: AgentPlan;
  createdAt: string;
}

export type SessionFinishStatus = "completed" | "stopped" | "failed";
export type SessionStopReason =
  | "estimated_cost_budget_exceeded"
  | "max_model_turns"
  | "active_context_exhausted"
  | "user_stopped"
  | "wall_clock_limit_exceeded"
  | "answer_once_tool_calls_blocked"
  | "no_progress";

export interface SessionAudit {
  changeGroups: AuditChangeGroups;
  verificationCommands: AuditVerificationCommand[];
  kernelObservedRisks: AuditRisk[];
  modelTurns: number;
  estimatedCostUsd: number;
  tracePath: string;
}

export interface WritingArtifact {
  path: string;
  contentKind: "draft" | "revision" | "final";
  contentBytes: number;
}

export interface AuditChangeGroups {
  inheritedForgeletChanged?: string[];
  forgeletChanged: string[];
  preExistingAtSessionStart: string[];
  otherCurrentWorkspaceChanges: string[];
}

export interface AuditVerificationCommand {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The command ran before the Session's last file change, so its exit code is
   * evidence about the workspace as it was, not about what the Session left
   * behind. Absent on commands that did verify the final state. */
  ranBeforeFinalChange?: true;
}

export type AuditRiskKind =
  | "verification_failed"
  | "verification_missing"
  | "pre_existing_workspace_changes"
  | "other_workspace_changes"
  | "session_stopped";

export interface AuditRisk {
  kind: AuditRiskKind;
  message: string;
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  paths?: string[];
  reason?: SessionStopReason;
}

export interface ContextAttachment {
  id: string;
  source: "user" | "file" | "browser" | "clipboard" | "issue" | "web";
  title?: string;
  uri?: string;
  mimeType: string;
  contentBytes: number;
  contentHash: string;
  preview: string;
  capturedAt?: string;
  /** Whether source capture limits omitted part of the attachment. */
  truncated?: boolean;
  /** Where the full attachment content is persisted for audit, when it is. */
  contentPath?: string;
  trustLevel: "user-provided" | "workspace" | "external";
}

export interface LoadedContextAttachment {
  attachment: ContextAttachment;
  content: string;
}

export interface ModelTurnInput {
  messages: ModelMessage[];
  tools: ToolSchema[];
  /** `"none"` offers the tools but forbids calling them. A wrap-up turn needs
   * that rather than an empty tool list: tool definitions sit in the cached
   * prompt prefix, so dropping them invalidates the prefix for the one turn
   * that carries the whole Session's context. */
  toolChoice?: "auto" | "none";
  effort?: ReasoningEffort;
  maxTokens?: number;
  onOutputDelta?: (delta: ModelOutputDelta) => void | Promise<void>;
  onReasoningDelta?: (delta: ModelReasoningDelta) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface ModelOutputDelta {
  text: string;
}

/** Progress of a turn's Provider Carryover while it streams. Only its size
 * crosses this boundary: the carryover itself is opaque and is never rendered
 * (ADR 0065), so a live view can report that thinking is happening without
 * being handed anything it must not show. */
export interface ModelReasoningDelta {
  bytesSoFar: number;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  /** Opaque provider state that must be replayed only within this Session. */
  providerCarryover?: string;
}

export type ReasoningEffort = "none" | "low" | "high" | "max";

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTurnOutput {
  content?: string;
  toolCalls: ModelToolCall[];
  finishReason?: string;
  providerCarryover?: string;
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputCacheHitTokens?: number;
  inputCacheMissTokens?: number;
  reasoningTokens?: number;
  estimatedCostUsd?: number;
}

export interface ModelClient {
  createTurn(input: ModelTurnInput): Promise<ModelTurnOutput>;
}

export interface ProviderConfig {
  model: string;
  apiKeyEnv?: string;
}

export interface ModelProvider {
  id: "openai" | "anthropic" | "deepseek";
  createClient(config: ProviderConfig): ModelClient;
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  providerId: string;
  capability: Capability;
  description: string;
  inputSchema: JsonSchema;
  classify?(
    input: unknown,
    ctx: ToolContext,
  ): ToolRequest | Promise<ToolRequest>;
  /** Runs after the permission decision but before the user is asked to
   * confirm, so a request that cannot succeed never spends their attention.
   * Return a failing ToolResult to abort the call with that result, or
   * undefined to proceed to approval. Must not mutate the workspace: it runs
   * on requests the user has not agreed to yet. */
  preflight?(
    input: unknown,
    ctx: ToolContext,
  ): ToolResult | undefined | Promise<ToolResult | undefined>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
  workflow: WorkflowKind;
  grantedCapabilities: Capability[];
  readScope?: string[];
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  errorCode?: ToolObservationErrorCode;
}

export interface ToolRequest {
  workflow: WorkflowKind;
  toolName: string;
  capability: Capability;
  riskTier: RiskTier;
  input: unknown;
  workspaceRoot: string;
  targets?: ToolTarget[];
}

export type ToolTarget =
  | {
      kind: "path";
      path: string;
      classification:
        | "ordinary"
        | "sensitive"
        | "internal"
        | "generated"
        | "dirty_at_session_start"
        | "delete_file"
        | "outside_workspace"
        | "outside_session_read_scope";
    }
  | {
      kind: "command";
      command: string;
      classification: "safe_configured" | "unsafe";
    }
  | {
      kind: "url";
      url: string;
      classification:
        | "ordinary"
        | "malformed"
        | "non_https_scheme"
        | "non_443_port"
        | "userinfo"
        | "local_hostname"
        | "private_ip";
    };

export type PermissionDecisionKind = "allow" | "confirm" | "deny";

export type RiskTier = "low" | "medium" | "high" | "forbidden";

export interface PermissionDecision {
  kind: PermissionDecisionKind;
  riskTier: RiskTier;
  reason: string;
}

export type ApprovalDecisionStatus = "approved" | "rejected" | "unavailable";

export interface ApprovalDecision {
  status: ApprovalDecisionStatus;
  reason: string;
  fullPatchShown?: boolean;
}

export interface PermissionPolicy {
  decide(request: ToolRequest): Promise<PermissionDecision>;
}

export interface BudgetLimits {
  maxModelTurns: number;
  maxEstimatedCostUsd: number;
  maxWallClockMs: number;
}

export interface BudgetUsage {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  unpricedTurns: number;
}
