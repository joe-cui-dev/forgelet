import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import type {
  JsonSchema,
  ModelClient,
  ModelMessage,
  ModelOutputDelta,
  ModelToolCall,
  ModelTurnInput,
  ModelTurnOutput,
  ModelUsage,
  ToolSchema,
} from "../../types.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const TOKENS_PER_MILLION = 1_000_000;
const RESPONSE_PREVIEW_BYTES = 500;

const DEEPSEEK_PRICES_USD_PER_1M: Record<
  string,
  { inputCacheHit: number; inputCacheMiss: number; output: number }
> = {
  "deepseek-v4-flash": {
    inputCacheHit: 0.0028,
    inputCacheMiss: 0.14,
    output: 0.28,
  },
  "deepseek-v4-pro": {
    inputCacheHit: 0.003625,
    inputCacheMiss: 0.435,
    output: 0.87,
  },
};

export const hasDeepSeekStaticPricing = (model: string): boolean =>
  model in DEEPSEEK_PRICES_USD_PER_1M;

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
  options?: PostJsonOptions,
) => Promise<DeepSeekChatResponse>;

export interface PostJsonOptions {
  onOutputDelta?: (delta: ModelOutputDelta) => void | Promise<void>;
  model: string;
  signal?: AbortSignal;
}

export class DeepSeekResponseError extends Error {
  readonly causeCategory?: string;
  readonly phase?: string;
  readonly elapsedMs?: number;
  readonly statusCode?: number;
  readonly responseBytes?: number;
  readonly responsePreview?: string;
  readonly providerErrorMessage?: string;
  readonly providerErrorType?: string;
  readonly providerErrorCode?: string;
  readonly diagnosticHint?: string;

  constructor(
    message: string,
    options: {
      causeCategory?: string;
      phase?: string;
      elapsedMs?: number;
      statusCode?: number;
      responseBytes?: number;
      responsePreview?: string;
      providerErrorMessage?: string;
      providerErrorType?: string;
      providerErrorCode?: string;
      diagnosticHint?: string;
    } = {},
  ) {
    super(message);
    this.causeCategory = options.causeCategory;
    this.phase = options.phase;
    this.elapsedMs = options.elapsedMs;
    this.statusCode = options.statusCode;
    this.responseBytes = options.responseBytes;
    this.responsePreview = options.responsePreview;
    this.providerErrorMessage = options.providerErrorMessage;
    this.providerErrorType = options.providerErrorType;
    this.providerErrorCode = options.providerErrorCode;
    this.diagnosticHint = options.diagnosticHint;
  }
}

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
    const stream = input.onOutputDelta !== undefined;
    const body: DeepSeekChatRequest = {
      model: this.model,
      messages: input.messages.map(toDeepSeekMessage),
      tools:
        input.tools.length > 0 ? input.tools.map(toDeepSeekTool) : undefined,
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
    };
    const response = await this.postJson(
      `${this.baseUrl}/chat/completions`,
      body,
      {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      { onOutputDelta: input.onOutputDelta, model: this.model, signal: input.signal },
    );
    return fromDeepSeekResponse(response, this.model);
  }
}

export interface DeepSeekChatRequest {
  model: string;
  messages: DeepSeekMessage[];
  tools?: DeepSeekTool[];
  stream: boolean;
  stream_options?: { include_usage: true };
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

export interface DeepSeekChatResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: DeepSeekToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
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

function toDeepSeekTool(tool: ToolSchema): DeepSeekTool {
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

function fromDeepSeekResponse(
  response: DeepSeekChatResponse,
  model: string,
): ModelTurnOutput {
  const choice = response.choices?.[0];
  const message = choice?.message;
  return {
    content: message?.content ?? undefined,
    toolCalls: (message?.tool_calls ?? []).map(fromDeepSeekToolCall),
    finishReason: choice?.finish_reason ?? undefined,
    usage: fromDeepSeekUsage(response.usage, model),
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
  model: string,
): ModelUsage | undefined {
  if (!usage) return undefined;
  const modelUsage: ModelUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    estimatedCostUsd:
      usage.estimated_cost_usd ?? estimateDeepSeekCostUsd(model, usage),
  };
  if (usage.prompt_cache_hit_tokens !== undefined)
    modelUsage.inputCacheHitTokens = usage.prompt_cache_hit_tokens;
  if (usage.prompt_cache_miss_tokens !== undefined)
    modelUsage.inputCacheMissTokens = usage.prompt_cache_miss_tokens;
  return modelUsage;
}

function estimateDeepSeekCostUsd(
  model: string,
  usage: NonNullable<DeepSeekChatResponse["usage"]>,
): number | undefined {
  const pricing = DEEPSEEK_PRICES_USD_PER_1M[model];
  if (!pricing) return undefined;
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheHitTokens = usage.prompt_cache_hit_tokens ?? 0;
  const cacheMissTokens =
    usage.prompt_cache_miss_tokens ??
    Math.max(promptTokens - cacheHitTokens, 0);
  const outputTokens = usage.completion_tokens ?? 0;
  return (
    (cacheHitTokens * pricing.inputCacheHit +
      cacheMissTokens * pricing.inputCacheMiss +
      outputTokens * pricing.output) /
    TOKENS_PER_MILLION
  );
}

async function postJsonWithHttps(
  url: string,
  body: DeepSeekChatRequest,
  headers: Record<string, string>,
  options: PostJsonOptions = { model: body.model },
): Promise<DeepSeekChatResponse> {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  const requestStartedAtMs = Date.now();
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const resolveOnce = (response: DeepSeekChatResponse): void => {
      if (settled) return;
      settled = true;
      resolveResponse(response);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectResponse(error);
    };
    const req = request(
      target,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (res) => {
        readDeepSeekResponse(res, {
          requestStartedAtMs,
          stream: body.stream,
          onOutputDelta: options.onOutputDelta,
          model: options.model,
        }).then(
          resolveOnce,
          rejectOnce,
        );
      },
    );
    req.on("error", (error) => {
      rejectOnce(deepSeekRequestError(error, requestStartedAtMs));
    });
    req.write(payload);
    req.end();
  });
}

export interface ReadDeepSeekResponseOptions {
  requestStartedAtMs?: number;
  stream?: boolean;
  onOutputDelta?: (delta: ModelOutputDelta) => void | Promise<void>;
  model?: string;
}

export function readDeepSeekResponse(
  res: IncomingMessage,
  options: ReadDeepSeekResponseOptions = {},
): Promise<DeepSeekChatResponse> {
  const requestStartedAtMs = options.requestStartedAtMs ?? Date.now();
  return new Promise((resolveResponse, rejectResponse) => {
    let settled = false;
    const resolveOnce = (response: DeepSeekChatResponse): void => {
      if (settled) return;
      settled = true;
      resolveResponse(response);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectResponse(error);
    };
    const chunks: Buffer[] = [];
    const streamState = options.stream
      ? createDeepSeekStreamState(options)
      : undefined;
    res.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (streamState && (res.statusCode ?? 500) < 400) {
        try {
          processDeepSeekStreamText(streamState, chunk.toString("utf8"));
        } catch (error) {
          rejectOnce(
            deepSeekResponseError(
              error instanceof Error ? error.message : String(error),
              res,
              chunks,
              requestStartedAtMs,
              "invalid_stream",
            ),
          );
        }
      }
    });
    res.on("aborted", () => {
      rejectOnce(
        deepSeekResponseError(
          "DeepSeek API response aborted before completion.",
          res,
          chunks,
          requestStartedAtMs,
          "response_aborted",
        ),
      );
    });
    res.on("error", (error) => {
      rejectOnce(
        deepSeekResponseError(
          error instanceof Error ? error.message : String(error),
          res,
          chunks,
          requestStartedAtMs,
          "response_error",
        ),
      );
    });
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if ((res.statusCode ?? 500) >= 400) {
        const providerError = parseDeepSeekProviderError(text);
        rejectOnce(
          deepSeekResponseError(
            `DeepSeek API request failed with ${res.statusCode}: ${
              providerError.providerErrorMessage ?? text
            }`,
            res,
            chunks,
            requestStartedAtMs,
            "http_error",
            providerError,
          ),
        );
        return;
      }
      if (streamState) {
        finishDeepSeekStream(streamState).then(resolveOnce, (error) => {
          rejectOnce(
            deepSeekResponseError(
              error instanceof Error ? error.message : String(error),
              res,
              chunks,
              requestStartedAtMs,
              "invalid_stream",
            ),
          );
        });
        return;
      }
      try {
        resolveOnce(JSON.parse(text) as DeepSeekChatResponse);
      } catch (error) {
        rejectOnce(
          deepSeekResponseError(
            error instanceof Error ? error.message : String(error),
            res,
            chunks,
            requestStartedAtMs,
            "invalid_json",
          ),
        );
      }
    });
  });
}

interface DeepSeekStreamState {
  buffer: string;
  content: string;
  toolCalls: Map<number, DeepSeekToolCallAccumulator>;
  finishReason?: string;
  usage?: DeepSeekChatResponse["usage"];
  sawDone: boolean;
  onOutputDelta?: (delta: ModelOutputDelta) => void | Promise<void>;
  deltaPromises: Promise<void>[];
}

interface DeepSeekToolCallAccumulator {
  id?: string;
  type?: "function";
  functionName?: string;
  arguments: string;
}

type DeepSeekStreamChunk = {
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
  }>;
  usage?: DeepSeekChatResponse["usage"] | null;
};

type DeepSeekToolCallDelta = Partial<DeepSeekToolCall> & {
  index?: number;
  function?: Partial<DeepSeekToolCall["function"]>;
};

function createDeepSeekStreamState(
  options: ReadDeepSeekResponseOptions,
): DeepSeekStreamState {
  return {
    buffer: "",
    content: "",
    toolCalls: new Map(),
    sawDone: false,
    onOutputDelta: options.onOutputDelta,
    deltaPromises: [],
  };
}

function processDeepSeekStreamText(
  state: DeepSeekStreamState,
  text: string,
): void {
  state.buffer += text.replace(/\r\n/g, "\n");
  let separatorIndex = state.buffer.indexOf("\n\n");
  while (separatorIndex >= 0) {
    const block = state.buffer.slice(0, separatorIndex);
    state.buffer = state.buffer.slice(separatorIndex + 2);
    processDeepSeekStreamBlock(state, block);
    separatorIndex = state.buffer.indexOf("\n\n");
  }
}

function processDeepSeekStreamBlock(
  state: DeepSeekStreamState,
  block: string,
): void {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");
  if (data === "[DONE]") {
    state.sawDone = true;
    return;
  }
  const chunk = JSON.parse(data) as DeepSeekStreamChunk;
  if (chunk.usage) state.usage = chunk.usage;
  const choice = chunk.choices?.[0];
  const text = choice?.delta?.content ?? undefined;
  if (text) {
    state.content += text;
    if (state.onOutputDelta)
      state.deltaPromises.push(Promise.resolve(state.onOutputDelta({ text })));
  }
  for (const toolCall of choice?.delta?.tool_calls ?? [])
    accumulateDeepSeekToolCall(state, toolCall);
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
}

function accumulateDeepSeekToolCall(
  state: DeepSeekStreamState,
  delta: DeepSeekToolCallDelta,
): void {
  const index = delta.index ?? 0;
  const existing =
    state.toolCalls.get(index) ??
    ({ arguments: "" } satisfies DeepSeekToolCallAccumulator);
  if (delta.id) existing.id = delta.id;
  if (delta.type === "function") existing.type = "function";
  if (delta.function?.name) existing.functionName = delta.function.name;
  if (delta.function?.arguments) existing.arguments += delta.function.arguments;
  state.toolCalls.set(index, existing);
}

async function finishDeepSeekStream(
  state: DeepSeekStreamState,
): Promise<DeepSeekChatResponse> {
  if (state.buffer.trim().length > 0) {
    const remaining = state.buffer;
    state.buffer = "";
    processDeepSeekStreamBlock(state, remaining);
  }
  await Promise.all(state.deltaPromises);
  if (!state.sawDone)
    throw new Error("DeepSeek API stream ended before data: [DONE].");
  const toolCalls = Array.from(state.toolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toCompleteDeepSeekToolCall(toolCall));
  return {
    choices: [
      {
        finish_reason: state.finishReason,
        message: {
          content: state.content,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      },
    ],
    usage: state.usage ?? undefined,
  };
}

function toCompleteDeepSeekToolCall(
  toolCall: DeepSeekToolCallAccumulator,
): DeepSeekToolCall {
  if (!toolCall.id || !toolCall.functionName)
    throw new Error("DeepSeek API stream ended with an incomplete tool call.");
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.functionName,
      arguments: toolCall.arguments,
    },
  };
}

function deepSeekResponseError(
  message: string,
  res: IncomingMessage,
  chunks: Buffer[],
  requestStartedAtMs: number,
  causeCategory: string,
  providerError: ProviderErrorDetails = {},
): DeepSeekResponseError {
  const text = Buffer.concat(chunks).toString("utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  const elapsed = elapsedMs(requestStartedAtMs);
  const category =
    causeCategory === "response_aborted" && bytes === 0
      ? "response_aborted_empty_body"
      : causeCategory;
  return new DeepSeekResponseError(message, {
    causeCategory: category,
    phase: "response",
    elapsedMs: elapsed,
    statusCode: res.statusCode,
    responseBytes: bytes,
    responsePreview: text.slice(0, RESPONSE_PREVIEW_BYTES),
    diagnosticHint: deepSeekDiagnosticHint(category, elapsed, providerError),
    ...providerError,
  });
}

type ProviderErrorDetails = {
  providerErrorMessage?: string;
  providerErrorType?: string;
  providerErrorCode?: string;
};

function deepSeekDiagnosticHint(
  causeCategory: string,
  elapsedMs: number,
  providerError: ProviderErrorDetails,
): string | undefined {
  if (providerError.providerErrorCode === "content_filter")
    return "provider_reported_content_filter";
  if (
    causeCategory === "response_aborted_empty_body" &&
    elapsedMs >= 50000
  )
    return "provider_or_network_closed_empty_response_after_wait";
  return undefined;
}

function parseDeepSeekProviderError(text: string): ProviderErrorDetails {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown; type?: unknown; code?: unknown };
    };
    const error = parsed.error;
    if (!error) return {};
    return {
      providerErrorMessage:
        typeof error.message === "string" ? error.message : undefined,
      providerErrorType:
        typeof error.type === "string" ? error.type : undefined,
      providerErrorCode:
        typeof error.code === "string" ? error.code : undefined,
    };
  } catch {
    return {};
  }
}

function deepSeekRequestError(
  error: unknown,
  requestStartedAtMs: number,
): DeepSeekResponseError {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const message = error instanceof Error ? error.message : String(error);
  return new DeepSeekResponseError(message, {
    causeCategory: "request_error",
    phase: "request",
    elapsedMs: elapsedMs(requestStartedAtMs),
    providerErrorCode:
      typeof record.code === "string" ? record.code : undefined,
  });
}

function elapsedMs(requestStartedAtMs: number): number {
  return Math.max(Date.now() - requestStartedAtMs, 0);
}
