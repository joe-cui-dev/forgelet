export type WorkflowKind = "coding" | "writing";

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
  task: string;
  stage: AgentStage;
  plan: AgentPlan;
  createdAt: string;
}

export type SessionFinishStatus = "completed" | "stopped" | "failed";
export type SessionStopReason = "budget_exceeded" | "max_model_turns";

export interface ContextAttachment {
  id: string;
  source: "user" | "file" | "browser" | "clipboard" | "issue";
  title?: string;
  uri?: string;
  mimeType: string;
  contentBytes: number;
  contentHash: string;
  preview: string;
  trustLevel: "user-provided" | "workspace" | "external";
}

export interface LoadedContextAttachment {
  attachment: ContextAttachment;
  content: string;
}

export type MemorySuggestionStatus = "proposed" | "accepted" | "rejected";

export interface MemorySuggestion {
  id: string;
  sourceSessionId: string;
  text: string;
  reason: string;
  status: MemorySuggestionStatus;
}

export interface ModelTurnInput {
  task: string;
  messages: ModelMessage[];
  tools: ToolSchema[];
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTurnOutput {
  content?: string;
  toolCalls: ModelToolCall[];
  usage?: ModelUsage;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputCacheHitTokens?: number;
  inputCacheMissTokens?: number;
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
  classify?(input: unknown, ctx: ToolContext): ToolRequest | Promise<ToolRequest>;
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
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

export type ToolObservationErrorCode =
  | "unknown_tool"
  | "permission_denied"
  | "invalid_input"
  | "tool_failed";

export interface ToolObservation {
  ok: boolean;
  toolCallId: string;
  toolName: string;
  summary: string;
  content?: string;
  error?: {
    code: ToolObservationErrorCode;
    message: string;
  };
  metadata: {
    truncated?: boolean;
    totalBytes?: number;
    returnedBytes?: number;
    contentHash?: string;
    path?: string;
    preview?: string;
  };
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
        | "outside_workspace";
    }
  | {
      kind: "command";
      command: string;
      classification: "safe_configured" | "unsafe";
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
  maxInputTokens: number;
  maxEstimatedCostUsd: number;
}

export interface BudgetUsage {
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface TraceEvent {
  type: string;
  ts: string;
  sessionId: string;
  payload: Record<string, unknown>;
}
