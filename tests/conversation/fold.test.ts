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

test("anchors the fold prompt to the Session task", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "Read old.ts." }]);

  await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "Explain how the ReAct loop works.",
    modelClient,
  });

  const systemMessage = modelClient.turnInputs[0]?.messages[0];
  expect(systemMessage?.content).toContain(
    "Session task: Explain how the ReAct loop works.",
  );
});

test("tells the summarizer not to imitate the Fact Ledger", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "Read old.ts." }]);

  await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  const systemMessage = modelClient.turnInputs[0]?.messages[0];
  expect(systemMessage?.role).toBe("system");
  expect(systemMessage?.content).toContain(
    "Do not copy or imitate the Fact Ledger section in your narrative",
  );
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

test("counts the rendered Rolling Summary envelope before deciding a fold fits", async () => {
  const conversation: ModelMessage[] = [assistantTurn("call_only", 100)];
  const modelClient = scriptedModelClient([{ content: "unused" }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: {
      text: "Prior narrative.",
      ledger: { files: [], changedFiles: [], commands: [] },
    },
    maxConversationBytes: 140,
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

test("performs a Degraded Fold on the second consecutive summarization failure", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient: ModelClient = {
    async createTurn() {
      throw new Error("model unavailable");
    },
  };

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: {
      text: "Prior narrative.\n\nFact Ledger: (empty)",
      ledger: { files: [], changedFiles: [], commands: [] },
    },
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
    failedFoldAttempts: 1,
  });

  expect(result.outcome).toBe("folded");
  if (result.outcome !== "folded") throw new Error("expected folded");
  expect(result.rollingSummary.text).toContain("Prior narrative.");
  expect(result.rollingSummary.text).toContain(
    "Degraded Fold: summarization failed after 2 consecutive attempts",
  );
  expect(result.rollingSummary.ledger.files.map((file) => file.path)).toEqual([
    "old.ts",
  ]);
  expect(result.trace).toMatchObject({
    degraded: true,
    reason: "model unavailable",
    failedAttemptCount: 2,
  });
  expect(conversation).toEqual(turnWithFileRead("call_new", "new.ts", 500));
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
        files: [
          {
            path: "oldest.ts",
            ranges: [{ kind: "byte", start: 0, end: 100, total: 100 }],
          },
        ],
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

test("clips an oversized narrative to the 25 percent sub-budget without failing the fold", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "界".repeat(80) }]);

  const result = await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 400,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  expect(result.outcome).toBe("folded");
  if (result.outcome !== "folded") throw new Error("expected folded");
  const narrative = result.rollingSummary.text.split("\n\nFact Ledger:")[0] ?? "";
  expect(Buffer.byteLength(narrative, "utf8")).toBeLessThanOrEqual(100);
  expect(narrative).toContain("[Narrative clipped; see Trace.]");
  expect(narrative).not.toContain("\uFFFD");
  expect(result.trace.narrativeClipped).toBe(true);
  expect(
    modelClient.turnInputs[0]?.messages[0]?.content,
  ).toContain("100 bytes");
});

test("passes only the prior narrative into the fold prompt, not the Fact Ledger", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_older", "older.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "Updated narrative." }]);

  await attemptConversationFold({
    conversation,
    rollingSummary: {
      text: "Prior narrative.\n\nFact Ledger:\nFiles read:\n- oldest.ts: byte range 0-100 of 100",
      ledger: {
        files: [
          {
            path: "oldest.ts",
            ranges: [{ kind: "byte", start: 0, end: 100, total: 100 }],
          },
        ],
        changedFiles: [],
        commands: [],
      },
    },
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  const summarizationMessages = modelClient.turnInputs[0]?.messages ?? [];
  const priorNarrativeMessage = summarizationMessages.find((message) =>
    message.content.includes("Existing narrative:"),
  );
  expect(priorNarrativeMessage?.content).toContain("Prior narrative.");
  expect(priorNarrativeMessage?.content).not.toContain("Fact Ledger:");
  expect(priorNarrativeMessage?.content).not.toContain("oldest.ts: byte range");
});

test("narrative contract preserves findings over activity recap", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "Read old.ts." }]);

  await attemptConversationFold({
    conversation,
    rollingSummary: undefined,
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  const systemMessage = modelClient.turnInputs[0]?.messages[0];
  expect(systemMessage?.content).toContain(
    "findings, conclusions, and open judgments still needed to complete the Session task",
  );
  expect(systemMessage?.content).toContain(
    "not an activity recap",
  );
});

test("narrative contract asks the fold model to prefer new evidence over the existing narrative", async () => {
  const conversation: ModelMessage[] = [
    ...turnWithFileRead("call_old", "old.ts", 5_000),
    ...turnWithFileRead("call_new", "new.ts", 500),
  ];
  const modelClient = scriptedModelClient([{ content: "Read old.ts." }]);

  await attemptConversationFold({
    conversation,
    rollingSummary: {
      text: "Stale narrative.\n\nFact Ledger: (empty)",
      ledger: { files: [], changedFiles: [], commands: [] },
    },
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    task: "task",
    modelClient,
  });

  const finalMessage =
    modelClient.turnInputs[0]?.messages.at(-1);
  expect(finalMessage?.content).toContain(
    "prefer the evidence in the turns above over the existing narrative",
  );
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
