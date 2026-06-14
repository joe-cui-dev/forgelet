export type AgentStage = "intake" | "plan" | "work" | "review" | "final";

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
  task: string;
  stage: AgentStage;
  plan: AgentPlan;
  createdAt: string;
}

export interface ContextAttachment {
  id: string;
  source: "user" | "file" | "browser" | "clipboard" | "issue";
  title?: string;
  uri?: string;
  mimeType: string;
  content: string;
  trustLevel: "user-provided" | "workspace" | "external";
}

export interface ModelTurnInput {
  task: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  sessionId: string;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
}

export interface ToolRequest {
  toolName: string;
  input: unknown;
  workspaceRoot: string;
}

export type PermissionDecisionKind = "allow" | "confirm" | "deny";

export interface PermissionDecision {
  kind: PermissionDecisionKind;
  reason: string;
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
