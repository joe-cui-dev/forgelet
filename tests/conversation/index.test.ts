import { expect, test } from "@jest/globals";
import { createActiveContextCompactor } from "../../src/conversation/index.js";
import type { ModelMessage } from "../../src/types.js";

test("fits a turn through the public compactor seam and retains fold state", async () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_old", "x".repeat(5_000)),
    toolObservation("call_old", "old.txt", "a".repeat(5_000)),
    assistantToolCall("call_new"),
    toolObservation("call_new", "new.txt", "new"),
  ];
  const traceTypes: string[] = [];
  const compactor = createActiveContextCompactor({
    modelClient: {
      async createTurn() {
        return {
          content: "Old file established the relevant fact.",
          toolCalls: [],
        };
      },
    },
    task: "inspect files",
    sessionId: "sess_1",
    model: "test-model",
    appendTrace: async (type) => {
      traceTypes.push(type);
    },
    maxConversationBytes: 4_000,
    observationDigestPreviewBytes: 256,
    protectedRecentTurns: 1,
  });

  const result = await compactor.fitTurn(conversation, 2);

  expect(result.outcome).toBe("fitted");
  expect(result).toMatchObject({
    foldUsage: { inputTokens: 0, outputTokens: 0 },
    rollingSummaryMessage: { role: "user" },
  });
  expect(traceTypes).toContain("conversation_folded");
  expect(compactor.state().rollingSummary?.text).toContain("relevant fact");
  expect(compactor.state().failedFoldAttempts).toBe(0);
  expect(conversation.map((message) => message.toolCallId)).toEqual([
    undefined,
    "call_new",
  ]);
});

function assistantToolCall(toolCallId: string, content = ""): ModelMessage {
  return {
    role: "assistant",
    content,
    toolCalls: [{ id: toolCallId, name: "read_file", input: {} }],
  };
}

function toolObservation(
  toolCallId: string,
  path: string,
  content: string,
): ModelMessage {
  return {
    role: "tool",
    toolCallId,
    content: JSON.stringify({
      ok: true,
      toolCallId,
      toolName: "read_file",
      summary: `Read ${path}.`,
      content,
      metadata: { path, contentHash: `${path}-hash` },
    }),
  };
}
