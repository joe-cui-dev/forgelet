import { DeepSeekModelClient } from "./deepseek.js";
import { loadDotEnv } from "../../config/env.js";
import type { ModelMessage, ModelOutputDelta, ToolSchema } from "../../types.js";

const pingTool: ToolSchema = {
  name: "ping_tool",
  description: "Echo a short message for protocol validation.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
};

interface SmokeScenario {
  stream: boolean;
  replayCarryover: boolean;
}

async function runScenario(
  client: DeepSeekModelClient,
  scenario: SmokeScenario,
): Promise<Record<string, unknown>> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: "You are validating a tool-call protocol. Call ping_tool with message 'hello', then answer with a short confirmation after its result.",
    },
    { role: "user", content: "Please call ping_tool once." },
  ];
  const onOutputDelta = scenario.stream
    ? (_delta: ModelOutputDelta) => undefined
    : undefined;
  const first = await client.createTurn({
    messages,
    tools: [pingTool],
    effort: "max",
    onOutputDelta,
  });
  if (first.toolCalls.length === 0)
    throw new Error("DeepSeek smoke did not return a tool call in its first turn.");

  messages.push({
    role: "assistant",
    content: first.content ?? "",
    toolCalls: first.toolCalls,
    ...(scenario.replayCarryover && first.providerCarryover
      ? { providerCarryover: first.providerCarryover }
      : {}),
  });
  for (const toolCall of first.toolCalls) {
    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content: JSON.stringify({ ok: true, message: "hello" }),
    });
  }
  const second = await client.createTurn({
    messages,
    tools: [pingTool],
    effort: "max",
    onOutputDelta,
  });
  if (second.toolCalls.length > 0 || !second.content?.trim())
    throw new Error("DeepSeek smoke did not return a final answer in its second turn.");

  return {
    stream: scenario.stream,
    replayCarryover: scenario.replayCarryover,
    firstCarryoverBytes: Buffer.byteLength(first.providerCarryover ?? "", "utf8"),
    firstFinishReason: first.finishReason,
    secondFinishReason: second.finishReason,
    finalContentBytes: Buffer.byteLength(second.content, "utf8"),
  };
}

async function main(): Promise<void> {
  await loadDotEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey)
    throw new Error("DEEPSEEK_API_KEY is required for npm run smoke:deepseek.");
  const client = new DeepSeekModelClient({
    apiKey,
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash",
  });
  const outcomes: Record<string, unknown>[] = [];
  for (const stream of [false, true]) {
    for (const replayCarryover of [true, false]) {
      outcomes.push(await runScenario(client, { stream, replayCarryover }));
    }
  }
  console.log(JSON.stringify({ outcomes }, null, 2));
}

await main();
