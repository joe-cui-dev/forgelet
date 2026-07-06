import { expect, test } from "@jest/globals";
import {
  attemptConversationFold,
  rollingSummaryMessage,
} from "../../src/conversation/fold.js";
import type {
  ModelClient,
  ModelMessage,
  ModelTurnInput,
} from "../../src/types.js";

test("does nothing when the conversation is within budget", async () => {
  const conversation: ModelMessage[] = [assistantTurn("t1", 100)];
  const modelClient = scriptedModelClient([{ content: "summary" }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 10_000,
    protectedRecentTurns: 3,
    task: "task",
    modelClient,
  });

  expect(result).toEqual({ outcome: "none" });
  expect(conversation).toHaveLength(1);
});

test("folds the oldest turns and builds a Rolling Summary with a Fact Ledger", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([
    { content: "Read old.ts and new.ts." },
  ]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  expect(result.outcome).toBe("folded");
  if (result.outcome !== "folded") throw new Error("expected folded");
  expect(result.rollingSummary.text).toContain("Read old.ts and new.ts.");
  expect(result.rollingSummary.text).toContain("old.ts");
  expect(result.rollingSummary.ledger.files.map((file) => file.path)).toEqual(
    ["old.ts"],
  );
  expect(conversation).toEqual(turnWithFileRead("call_new", "new.ts", 500));
  expect(modelClient.turnInputs[0]?.tools).toEqual([]);
});

test("signals stop when protected turns plus an existing Rolling Summary alone exceed budget", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_only", "big.ts", 8_000),
  ];
  const modelClient = scriptedModelClient([{ content: "unused" }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: {
      text: "Prior narrative.\n\nFact Ledger: (empty)",
      ledger: { files: [], changedFiles: [], commands: [] },
    },
    maxConversationBytes: 4_000,
    protectedRecentTurns: 3,
    task: "task",
    modelClient,
  });

  expect(result).toEqual({ outcome: "stop" });
  expect(modelClient.turnInputs).toHaveLength(0);
});

test("tolerates an oversized protected region when nothing has folded yet", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_only", "big.ts", 8_000),
  ];
  const modelClient = scriptedModelClient([{ content: "unused" }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 3,
    task: "task",
    modelClient,
  });

  expect(result).toEqual({ outcome: "none" });
  expect(modelClient.turnInputs).toHaveLength(0);
});

test("leaves the conversation untouched when the summarization call returns an empty response", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const before = structuredClone(conversation);
  const modelClient = scriptedModelClient([{ content: "   " }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  expect(result).toEqual({ outcome: "failed", reason: "empty_summary" });
  expect(conversation).toEqual(before);
});

test("leaves the conversation untouched when the summarization call throws", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const before = structuredClone(conversation);
  const modelClient: ModelClient = {
    async createTurn() {
      throw new Error("model unavailable");
    },
  };

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  expect(result).toEqual({ outcome: "failed", reason: "model unavailable" });
  expect(conversation).toEqual(before);
});

test("a refold absorbs the previous Rolling Summary into the new one", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_older", "older.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "Updated narrative." }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: {
      text: "Prior narrative.\n\nFact Ledger:\nFiles read:\n- oldest.ts: byte range 0-100 of 100",
      ledger: {
        files: [{ path: "oldest.ts", ranges: ["byte range 0-100 of 100"] }],
        changedFiles: [],
        commands: [],
      },
    },
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  expect(result.outcome).toBe("folded");
  if (result.outcome !== "folded") throw new Error("expected folded");
  expect(result.rollingSummary.ledger.files.map((file) => file.path)).toEqual(
    ["oldest.ts", "older.ts"],
  );
  const summarizationMessages = modelClient.turnInputs[0]?.messages ?? [];
  expect(
    summarizationMessages.some((message) =>
      message.content.includes("Prior narrative."),
    ),
  ).toBe(true);
});

test("rollingSummaryMessage renders the stored text for the model", () => {
  expect(rollingSummaryMessage(undefined)).toBeUndefined();
  const message = rollingSummaryMessage({
    text: "Narrative.\n\nFact Ledger: (empty)",
    ledger: { files: [], changedFiles: [], commands: [] },
  });
  expect(message?.role).toBe("user");
  expect(message?.content).toContain("Narrative.");
});

function scriptedModelClient(
  outputs: { content: string }[],
): ModelClient & { turnInputs: ModelTurnInput[] } {
  const queue = [...outputs];
  const turnInputs: ModelTurnInput[] = [];
  return {
    turnInputs,
    async createTurn(input: ModelTurnInput) {
      turnInputs.push(input);
      const next = queue.shift();
      return { content: next?.content ?? "", toolCalls: [] };
    },
  };
}

function turnWithFileRead(
  toolCallId: string,
  path: string,
  bytes: number,
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: toolCallId, name: "read_file", input: { path } }],
    },
    {
      role: "tool",
      toolCallId,
      content: JSON.stringify({
        ok: true,
        toolCallId,
        toolName: "read_file",
        summary: `Read ${path}.`,
        content: "x".repeat(bytes),
        metadata: {
          path,
          contentHash: `${path}-hash`,
          returnedStartByte: 0,
          returnedEndByte: bytes,
          totalBytes: bytes,
        },
      }),
    },
  ];
}

function assistantTurn(id: string, contentBytes: number): ModelMessage {
  return {
    role: "assistant",
    content: "x".repeat(contentBytes),
    toolCalls: [{ id, name: "read_file", input: {} }],
  };
}
