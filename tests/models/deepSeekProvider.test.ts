import assert from "node:assert/strict";
import { test } from "../harness.js";
import { DeepSeekModelClient } from "../../src/models/providers/deepseek.js";

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
        providerId: "workspace",
        capability: "read_workspace",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        execute: async () => ({ ok: true, summary: "unused" }),
      },
    ],
  });

  assert.deepEqual(requestBody, {
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
  assert.equal(result.content, "I should inspect the file.");
  assert.deepEqual(result.toolCalls, [
    { id: "call_1", name: "read_file", input: { path: "README.md" } },
  ]);
  assert.deepEqual(result.usage, {
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

  assert.equal(result.usage?.inputTokens, 1000);
  assert.equal(result.usage?.inputCacheHitTokens, 100);
  assert.equal(result.usage?.inputCacheMissTokens, 900);
  assert.equal(result.usage?.outputTokens, 200);
  assert.ok(
    Math.abs((result.usage?.estimatedCostUsd ?? 0) - 0.0005658625) <
      Number.EPSILON,
  );
});
