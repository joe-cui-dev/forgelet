import { expect, test } from "@jest/globals";
import { createActiveContextCompactor } from "../../src/conversation/index.js";
import type { ModelMessage } from "../../src/types.js";

test("fits a turn through the pure public compactor seam without changing its input", async () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_old", "x".repeat(5_000)),
    toolObservation("call_old", "old.txt", "a".repeat(5_000)),
    assistantToolCall("call_new"),
    toolObservation("call_new", "new.txt", "new"),
  ];
  const before = structuredClone(conversation);
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
    settings: {
      maxConversationBytes: 4_000,
      observationDigestPreviewBytes: 256,
      protectedRecentTurns: 1,
    },
  });

  const result = await compactor.fitTurn(
    conversation,
    { failedFoldAttempts: 0 },
    2,
  );

  expect(result.outcome).toBe("fitted");
  expect(result).toMatchObject({
    foldUsage: { inputTokens: 0, outputTokens: 0 },
    rollingSummaryMessage: { role: "user" },
  });
  expect(result.state.rollingSummary?.text).toContain("relevant fact");
  expect(result.state.failedFoldAttempts).toBe(0);
  expect(traceTypes).toContain("conversation_folded");
  expect(traceTypes).toContain("conversation_compacted");
  expect(conversation).toEqual(before);
  expect(result.conversation.map((message) => message.toolCallId)).toEqual([
    undefined,
    "call_new",
  ]);
});

test("returns compacted observations without changing the input conversation", async () => {
  const conversation: ModelMessage[] = [
    assistantToolCall("call_old"),
    toolObservation("call_old", "old.txt", "a".repeat(5_000)),
    assistantToolCall("call_new"),
    toolObservation("call_new", "new.txt", "new"),
  ];
  const before = structuredClone(conversation);
  const originalObservation = conversation[1];
  const compactor = createActiveContextCompactor({
    modelClient: {
      async createTurn() {
        throw new Error("fold should not run after compaction");
      },
    },
    task: "inspect files",
    sessionId: "sess_2",
    model: "test-model",
    appendTrace: async () => {},
    settings: {
      maxConversationBytes: 4_000,
      observationDigestPreviewBytes: 256,
      protectedRecentTurns: 1,
    },
  });

  const result = await compactor.fitTurn(
    conversation,
    { failedFoldAttempts: 0 },
    2,
  );

  expect(result.outcome).toBe("fitted");
  expect(conversation).toEqual(before);
  expect(result.conversation[1]).not.toBe(originalObservation);
  expect(JSON.parse(result.conversation[1]?.content ?? "{}")).toMatchObject({
    toolCallId: "call_old",
    toolName: "read_file",
    compacted: true,
  });
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
