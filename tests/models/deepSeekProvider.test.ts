import { expect, test } from "@jest/globals";
import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  DeepSeekModelClient,
  readDeepSeekResponse,
  type DeepSeekChatRequest,
} from "../../src/models/providers/deepseek.js";
import { pricingWindowAt } from "../../src/models/profiles.js";

/** `created` is Unix seconds. 12:00 UTC is off-peak, 02:00 UTC is inside the
 * first published peak window. Fixtures pin it so cost assertions do not depend
 * on what time of day the suite happens to run. */
const OFF_PEAK_CREATED = Math.floor(Date.UTC(2026, 7, 17, 12) / 1000);
const PEAK_CREATED = Math.floor(Date.UTC(2026, 7, 17, 2) / 1000);

test("DeepSeekModelClient converts Forgelet turns to chat completions with tools", async () => {
  let requestBody: unknown;
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async (_url, body) => {
      requestBody = body;
      return {
        created: OFF_PEAK_CREATED,
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
    pricingWindow: "off_peak",
    // (12 * 0.66 + 5 * 1.98) / 1e6 at the off-peak rates
    estimatedCostUsd: 0.00001782,
  });
});

test("DeepSeekModelClient sends tool_choice none with the tools still attached", async () => {
  // A wrap-up turn must keep the schemas in the body: they are part of the
  // cached prompt prefix, and dropping them re-bills the whole prefix.
  const bodies: DeepSeekChatRequest[] = [];
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    postJson: async (_url, body) => {
      bodies.push(body as DeepSeekChatRequest);
      return {
        choices: [{ finish_reason: "stop", message: { content: "Done." } }],
      };
    },
  });
  const tools = [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: {} },
    },
  ];

  await client.createTurn({
    messages: [{ role: "user", content: "wrap up" }],
    tools,
    toolChoice: "none",
  });
  await client.createTurn({
    messages: [{ role: "user", content: "work" }],
    tools,
    toolChoice: "auto",
  });
  // No tools means no choice to express, and the API rejects one without them.
  await client.createTurn({
    messages: [{ role: "user", content: "summarize" }],
    tools: [],
    toolChoice: "none",
  });

  expect(bodies[0]?.tool_choice).toBe("none");
  expect(bodies[0]?.tools).toHaveLength(1);
  expect(bodies[1]?.tool_choice).toBe("auto");
  expect(bodies[2]?.tools).toBeUndefined();
  expect(bodies[2]).not.toHaveProperty("tool_choice");
});

test("readDeepSeekResponse reports carryover size and its raw incremental text as it streams", async () => {
  const response = new PassThrough() as PassThrough & { statusCode?: number };
  response.statusCode = 200;
  const reported: number[] = [];
  const reportedText: string[] = [];
  const contentDeltas: string[] = [];
  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    stream: true,
    onOutputDelta: (delta) => {
      contentDeltas.push(delta.text);
    },
    onReasoningDelta: (delta) => {
      reported.push(delta.bytesSoFar);
      reportedText.push(delta.text);
    },
  });

  response.write(
    [
      'data: {"choices":[{"delta":{"reasoning_content":"abcde"},"finish_reason":null}],"usage":null}',
      "",
      'data: {"choices":[{"delta":{"reasoning_content":"fg"},"finish_reason":null}],"usage":null}',
      "",
      'data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}],"usage":null}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
  response.end();

  // bytesSoFar is cumulative, so a live view needs no state of its own to
  // track total size; text is the raw incremental delta (not cumulative),
  // symmetric with onOutputDelta — no throttling happens at this layer
  // (ADR 0079), that is the ReAct Node's job.
  expect(await result).toMatchObject({
    choices: [{ message: { reasoning_content: "abcdefg" } }],
  });
  expect(reported).toEqual([5, 7]);
  expect(reportedText).toEqual(["abcde", "fg"]);
  expect(contentDeltas).toEqual(["Done."]);
});

test("DeepSeekModelClient omits tool_calls for a carryover-only assistant turn", async () => {
  let requestBody: DeepSeekChatRequest | undefined;
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    postJson: async (_url, body) => {
      requestBody = body;
      return { choices: [{ message: { content: "Done." } }] };
    },
  });

  await client.createTurn({
    messages: [
      { role: "user", content: "Task" },
      {
        role: "assistant",
        content: "",
        toolCalls: [],
        providerCarryover: "opaque reasoning",
      },
    ],
    tools: [],
    effort: "max",
  });

  // The wire shape is what the API validates: an empty array is rejected, so
  // the key has to be absent, which `toEqual` alone would not distinguish.
  expect(JSON.stringify(requestBody)).not.toContain('"tool_calls"');
  expect(requestBody?.messages[1]).toEqual({
    role: "assistant",
    content: "",
    reasoning_content: "opaque reasoning",
  });
});

test("DeepSeekModelClient replays opaque Provider Carryover with an enabled effort", async () => {
  let requestBody: unknown;
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    postJson: async (_url, body) => {
      requestBody = body;
      return {
        choices: [
          {
            message: {
              content: "Done.",
              reasoning_content: "opaque reasoning",
            },
          },
        ],
      };
    },
  });

  const result = await client.createTurn({
    messages: [
      {
        role: "assistant",
        content: "I called the tool.",
        providerCarryover: "previous opaque reasoning",
      },
      { role: "tool", toolCallId: "call_1", content: "tool result" },
    ],
    tools: [],
    effort: "max",
  });

  expect(requestBody).toMatchObject({
    thinking: { type: "enabled" },
    reasoning_effort: "max",
  });
  expect((requestBody as { messages: unknown[] }).messages[0]).toEqual({
    role: "assistant",
    content: "I called the tool.",
    tool_calls: undefined,
    reasoning_content: "previous opaque reasoning",
  });
  expect(result.providerCarryover).toBe("opaque reasoning");
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

const usageOnlyResponse = (created?: number) => ({
  choices: [{ message: { content: "Done." } }],
  ...(created === undefined ? {} : { created }),
  usage: {
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 100,
    prompt_cache_miss_tokens: 900,
    completion_tokens: 200,
  },
});

test("DeepSeekModelClient estimates cost when the API returns token usage without cost", async () => {
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async () => usageOnlyResponse(OFF_PEAK_CREATED),
  });

  const result = await client.createTurn({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });

  expect(result.usage?.inputTokens).toBe(1000);
  expect(result.usage?.inputCacheHitTokens).toBe(100);
  expect(result.usage?.inputCacheMissTokens).toBe(900);
  expect(result.usage?.outputTokens).toBe(200);
  // (100 * 0.022 + 900 * 0.66 + 200 * 1.98) / 1e6
  expect(result.usage?.estimatedCostUsd).toBeCloseTo(0.0009922, 10);
  expect(result.usage?.pricingWindow).toBe("off_peak");
});

test("DeepSeekModelClient prices a turn stamped inside a peak window at double the off-peak rate", async () => {
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async () => usageOnlyResponse(PEAK_CREATED),
  });

  const result = await client.createTurn({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });

  expect(result.usage?.estimatedCostUsd).toBeCloseTo(0.0019844, 10);
  expect(result.usage?.pricingWindow).toBe("peak");
});

test("DeepSeekModelClient falls back to the local clock when the response omits created", async () => {
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    postJson: async () => usageOnlyResponse(),
  });

  const result = await client.createTurn({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });

  // The local clock decides which window applies, so only the two possible
  // outcomes are assertable — never that pricing silently went missing.
  const expected = pricingWindowAt(Date.now()) === "peak" ? 0.0019844 : 0.0009922;
  expect(result.usage?.estimatedCostUsd).toBeCloseTo(expected, 10);
  expect(result.usage?.pricingWindow).toBe(pricingWindowAt(Date.now()));
});

test("readDeepSeekResponse carries the created stamp off the stream so the turn can be priced", async () => {
  const stream = new PassThrough() as PassThrough & { statusCode?: number };
  stream.statusCode = 200;
  const response = readDeepSeekResponse(stream as unknown as IncomingMessage, {
    model: "deepseek-v4-pro",
    stream: true,
    onOutputDelta: () => {},
  });

  stream.write(
    `data: ${JSON.stringify({ created: PEAK_CREATED, choices: [{ delta: { content: "Done." } }] })}\n\n`,
  );
  stream.write(
    `data: ${JSON.stringify({
      created: PEAK_CREATED,
      choices: [{ finish_reason: "stop", delta: {} }],
      usage: { prompt_tokens: 1000, completion_tokens: 200 },
    })}\n\n`,
  );
  stream.write("data: [DONE]\n\n");
  stream.end();

  const result = await response;

  expect(result.created).toBe(PEAK_CREATED);
});

test("DeepSeekModelClient reports reasoning tokens separately from output tokens", async () => {
  const client = new DeepSeekModelClient({
    apiKey: "test-key",
    model: "deepseek-v4-flash",
    postJson: async () => ({
      choices: [{ message: { content: "Done." } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        completion_tokens_details: { reasoning_tokens: 15 },
      },
    }),
  });

  const result = await client.createTurn({
    messages: [{ role: "user", content: "Hello" }],
    tools: [],
  });

  expect(result.usage).toMatchObject({ outputTokens: 20, reasoningTokens: 15 });
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

test("readDeepSeekResponse retains streamed Provider Carryover without emitting it", async () => {
  const response = new PassThrough() as PassThrough & { statusCode?: number };
  response.statusCode = 200;
  const deltas: string[] = [];
  const result = readDeepSeekResponse(response as unknown as IncomingMessage, {
    stream: true,
    onOutputDelta: (delta) => {
      deltas.push(delta.text);
    },
  });

  response.write(
    [
      'data: {"choices":[{"delta":{"reasoning_content":"private "},"finish_reason":null}]}',
      "",
      'data: {"choices":[{"delta":{"reasoning_content":"carryover","content":"Visible."},"finish_reason":"stop"}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"),
  );
  response.end();

  await expect(result).resolves.toMatchObject({
    choices: [{ message: { content: "Visible.", reasoning_content: "private carryover" } }],
  });
  expect(deltas).toEqual(["Visible."]);
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
