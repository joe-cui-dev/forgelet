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
    task: "inspect readme",
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
  expect(result.usage).toEqual({
    inputTokens: 12,
    outputTokens: 5,
    estimatedCostUsd: 0.001,
  });
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
    task: "estimate cost",
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

test("readDeepSeekResponse rejects when the response is aborted before end", async () => {
  const response = new PassThrough() as PassThrough & {
    statusCode?: number;
  };
  response.statusCode = 200;

  const result = readDeepSeekResponse(response as unknown as IncomingMessage);
  response.write('{"choices":');
  response.emit("aborted");
  response.emit("error", Object.assign(new Error("socket hang up"), {
    code: "ECONNRESET",
  }));

  await expect(result).rejects.toThrow(
    "DeepSeek API response aborted before completion.",
  );
});
