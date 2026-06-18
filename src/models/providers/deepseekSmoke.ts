import { DeepSeekModelClient } from "./deepseek.js";
import { loadDotEnv } from "../../config/env.js";

async function main(): Promise<void> {
  await loadDotEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is required for npm run smoke:deepseek.");
  }

  const client = new DeepSeekModelClient({ apiKey, model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro" });
  const result = await client.createTurn({
    task: "Validate Forgelet tool-call protocol.",
    messages: [
      {
        role: "system",
        content: "You are validating a tool-call protocol. Call the provided ping_tool with message 'hello'."
      },
      {
        role: "user",
        content: "Please call ping_tool once."
      }
    ],
    tools: [
      {
        name: "ping_tool",
        providerId: "smoke",
        capability: "model_generate_text",
        description: "Echo a short message for protocol validation.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false
        },
        execute: async () => ({ ok: true, summary: "unused" })
      }
    ]
  });

  console.log(JSON.stringify({ content: result.content, toolCalls: result.toolCalls, usage: result.usage }, null, 2));
  if (result.toolCalls.length === 0) {
    throw new Error("DeepSeek smoke did not return a tool call.");
  }
}

await main();
