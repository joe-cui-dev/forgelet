import { expect, test } from "@jest/globals";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  DeepSeekModelClient,
  readDeepSeekResponse,
} from "../../src/models/providers/deepseek.js";

test("DeepSeekModelClient converts Forgelet turns to chat completions with tools", async () => {
  let requestBody: unknown;
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async (_url, body) => {
      requestBody = body;
      return {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "I should inspect the file.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"README.md"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          estimated_cost_usd: 0.001,
        },
      };
    },
  });

  const result = await client.createTurn({
    messages: [
      { role: "system", content: "Kernel rules" },
      { role: "user", content: "Task: inspect readme" },
    ],
    tools: [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    ],
  });

  expect(requestBody).toEqual({
    model: "deepseek-v4-pro",
    messages: [
      { role: "system", content: "Kernel rules" },
      { role: "user", content: "Task: inspect readme" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      },
    ],
    stream: false,
  });
  expect(result.content).toBe("I should inspect the file.");
  expect(result.toolCalls).toEqual([
    { id: "call_1", name: "read_file", input: { path: "README.md" } },
  ]);
  expect(result.finishReason).toBe("tool_calls");
  expect(result.usage).toEqual({
    inputTokens: 12,
    outputTokens: 5,
    estimatedCostUsd: 0.001,
  });
});

test("DeepSeekModelClient forwards a caller AbortSignal to the fetch adapter", async () => {
  let observedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async (_url, _body, _headers, options) => {
      observedSignal = options?.signal;
      return { choices: [{ message: { content: "Done." } }] };
    },
  });

  await client.createTurn({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
    signal: controller.signal,
  });

  expect(observedSignal).toBe(controller.signal);
});

test("DeepSeekModelClient estimates cost when the API returns token usage without cost", async () => {
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async () => ({
      choices: [{ message: { content: "Done." } }],
      usage: {
        prompt_tokens: 1000,
        prompt_cache_hit_tokens: 100,
        prompt_cache_miss_tokens: 900,
        completion_tokens: 200,
      },
    }),
  });

  const result = await client.createTurn({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });

  expect(result.usage?.inputTokens).toBe(1000);
  expect(result.usage?.inputCacheHitTokens).toBe(100);
  expect(result.usage?.inputCacheMissTokens).toBe(900);
  expect(result.usage?.outputTokens).toBe(200);
  expect(Math.abs((result.usage?.estimatedCostUsd ?? 0) - 0.0005658625) <
      Number.EPSILON).toBeTruthy();
});

test("DeepSeekModelClient requests streaming and emits text deltas when caller observes output", async () => {
  let requestBody: unknown;
  const deltas: string[] = [];
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    postJson: async (_url, body, _headers, options) => {
      requestBody = body;
      await options?.onOutputDelta?.({ text: "Hello" });
      await options?.onOutputDelta?.({ text: " world" });
      return {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Hello world" },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
        },
      };
    },
  });

  const result = await client.createTurn({
    messages: [{ role: "user", content: "Say hello" }],
    tools: [],
    onOutputDelta: (delta) => {
      deltas.push(delta.text);
    },
  });

  expect(requestBody).toMatchObject({
    model: "deepseek-v4-flash",
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(deltas).toEqual(["Hello", " world"]);
  expect(result.content).toBe("Hello world");
  expect(result.finishReason).toBe("stop");
  expect(result.usage?.inputTokens).toBe(10);
  expect(result.usage?.outputTokens).toBe(2);
});

test("readDeepSeekResponse parses streaming chunks into one chat response", async () => {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
  };
  response.statusCode = 200;
  const deltas: string[] = [];

  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    requestStartedAtMs: Date.now() - 10,
    stream: true,
    model: "deepseek-v4-flash",
    onOutputDelta: (delta) => {
      deltas.push(delta.text);
    },
  });

  response.write(
    [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}],"usage":null}',
      "",
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":null}',
      "",
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
  response.end();

  await expect(result).resolves.toMatchObject({
    choices: [
      {
        finish_reason: "stop",
        message: { content: "Hello world" },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 2,
    },
  });
  expect(deltas).toEqual(["Hello", " world"]);
});

test("readDeepSeekResponse buffers streaming tool call deltas without emitting text", async () => {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
  };
  response.statusCode = 200;
  const deltas: string[] = [];

  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    requestStartedAtMs: Date.now() - 10,
    stream: true,
    model: "deepseek-v4-flash",
    onOutputDelta: (delta) => {
      deltas.push(delta.text);
    },
  });

  response.write(
    [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\""}}]},"finish_reason":null}],"usage":null}',
      "",
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":null}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
  response.end();

  await expect(result).resolves.toMatchObject({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: '{"path":"README.md"}',
              },
            },
          ],
        },
      },
    ],
  });
  expect(deltas).toEqual([]);
});

test("readDeepSeekResponse rejects when the response is aborted before end", async () => {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
  };
  response.statusCode = 200;

  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    requestStartedAtMs: Date.now() - 1234,
  });
  response.write('{"choices":');
  response.emit("aborted");
  response.emit("error", Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
  }));

  await expect(result).rejects.toMatchObject({
    message: "DeepSeek API response aborted before completion.",
    causeCategory: "response_aborted",
    phase: "response",
    statusCode: 200,
    elapsedMs: expect.any(Number),
    responseBytes: 11,
    responsePreview: '{"choices":',
  });
});

test("readDeepSeekResponse rejects HTTP error responses with provider details", async () => {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
  };
  response.statusCode = 400;

  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    requestStartedAtMs: Date.now() - 10,
  });
  response.end(
    JSON.stringify({
      error: {
        message: "Content violates policy",
        type: "invalid_request_error",
        code: "content_filter",
      },
    }),
  );

  await expect(result).rejects.toMatchObject({
    message: "DeepSeek API request failed with 400: Content violates policy",
    causeCategory: "http_error",
    phase: "response",
    statusCode: 400,
    providerErrorMessage: "Content violates policy",
    providerErrorType: "invalid_request_error",
    providerErrorCode: "content_filter",
    diagnosticHint: "provider_reported_content_filter",
    responsePreview: expect.stringContaining("Content violates policy"),
  });
});

test("readDeepSeekResponse classifies empty aborted responses as likely upstream timeout", async () => {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
  };
  response.statusCode = 200;

  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    requestStartedAtMs: Date.now() - 60000,
  });
  response.emit("aborted");

  await expect(result).rejects.toMatchObject({
    message: "DeepSeek API response aborted before completion.",
    causeCategory: "response_aborted_empty_body",
    diagnosticHint: "provider_or_network_closed_empty_response_after_wait",
    phase: "response",
    statusCode: 200,
    responseBytes: 0,
    responsePreview: "",
  });
});
