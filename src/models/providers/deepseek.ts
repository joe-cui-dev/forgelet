import { request } from "node:https";
import type {
  JsonSchema,
  ModelClient,
  ModelMessage,
  ModelToolCall,
  ModelTurnInput,
  ModelTurnOutput,
  ModelUsage,
  ToolDefinition,
} from "../../types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface DeepSeekModelClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  postJson?: PostJson;
}

export type PostJson = (
  url: string,
  body: DeepSeekChatRequest,
  headers: Record<string, string>,
) => Promise<DeepSeekChatResponse>;

export class DeepSeekModelClient implements ModelClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly postJson: PostJson;

  constructor(options: DeepSeekModelClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.postJson = options.postJson ?? postJsonWithHttps;
  }

  async createTurn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    const body: DeepSeekChatRequest = {
      model: this.model,
      messages: input.messages.map(toDeepSeekMessage),
      tools:
        input.tools.length > 0 ? input.tools.map(toDeepSeekTool) : undefined,
      stream: false,
    };
    const response = await this.postJson(
      `${this.baseUrl}/chat/completions`,
      body,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
    );
    return fromDeepSeekResponse(response);
  }
}

interface DeepSeekChatRequest {
  model: string;
  messages: DeepSeekMessage[];
  tools?: DeepSeekTool[];
  stream: false;
}

type DeepSeekMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: DeepSeekToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface DeepSeekTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

interface DeepSeekChatResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: DeepSeekToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    estimated_cost_usd?: number;
  };
}

interface DeepSeekToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

function toDeepSeekMessage(message: ModelMessage): DeepSeekMessage {
  if (message.role === "tool") {
    if (!message.toolCallId)
      throw new Error("Tool messages sent to DeepSeek require toolCallId.");
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls?.map(toDeepSeekToolCall),
    };
  }
  return { role: message.role, content: message.content };
}

function toDeepSeekTool(tool: ToolDefinition): DeepSeekTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toDeepSeekToolCall(toolCall: ModelToolCall): DeepSeekToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input ?? {}),
    },
  };
}

function fromDeepSeekResponse(response: DeepSeekChatResponse): ModelTurnOutput {
  const message = response.choices?.[0]?.message;
  return {
    content: message?.content ?? undefined,
    toolCalls: (message?.tool_calls ?? []).map(fromDeepSeekToolCall),
    usage: fromDeepSeekUsage(response.usage),
  };
}

function fromDeepSeekToolCall(toolCall: DeepSeekToolCall): ModelToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    input: parseToolArguments(toolCall.function.arguments),
  };
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function fromDeepSeekUsage(
  usage: DeepSeekChatResponse["usage"],
): ModelUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    estimatedCostUsd: usage.estimated_cost_usd,
  };
}

async function postJsonWithHttps(
  url: string,
  body: DeepSeekChatRequest,
  headers: Record<string, string>,
): Promise<DeepSeekChatResponse> {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  return new Promise((resolveResponse, rejectResponse) => {
    const req = request(
      target,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            rejectResponse(
              new Error(
                `DeepSeek API request failed with ${res.statusCode}: ${text}`,
              ),
            );
            return;
          }
          try {
            resolveResponse(JSON.parse(text) as DeepSeekChatResponse);
          } catch (error) {
            rejectResponse(error);
          }
        });
      },
    );
    req.on("error", rejectResponse);
    req.write(payload);
    req.end();
  });
}
