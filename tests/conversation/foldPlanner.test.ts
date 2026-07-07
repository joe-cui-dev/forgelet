import { expect, test } from "@jest/globals";
import { planFold } from "../../src/conversation/foldPlanner.js";
import type { ModelMessage } from "../../src/types.js";

test("does not fold when the conversation is within budget", () => {
  const turns = [assistantTurn("t1", 100)];

  const plan = planFold(turns, {
    maxConversationBytes: 10_000,
    protectedRecentTurns: 3,
    rollingSummaryBytes: 0,
  });

  expect(plan).toEqual({ action: "none" });
});

test("folds the oldest turns down to the low-water mark, keeping protected recent turns", () => {
  const turns = [
    ...turnWithObservation("t1", 5_000),
    ...turnWithObservation("t2", 500),
    ...turnWithObservation("t3", 500),
    ...turnWithObservation("t4", 500),
  ];

  const plan = planFold(turns, {
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    rollingSummaryBytes: 0,
  });

  expect(plan.action).toBe("fold");
  if (plan.action !== "fold") throw new Error("expected fold");
  expect(plan.foldTurns).toEqual([...turnWithObservation("t1", 5_000)]);
  expect(plan.keptTurns).toEqual([
    ...turnWithObservation("t2", 500),
    ...turnWithObservation("t3", 500),
    ...turnWithObservation("t4", 500),
  ]);
});

test("signals stop when protected turns plus an existing Rolling Summary alone exceed budget", () => {
  const turns = [
    ...turnWithObservation("t1", 8_000),
    ...turnWithObservation("t2", 8_000),
  ];

  const plan = planFold(turns, {
    maxConversationBytes: 4_000,
    protectedRecentTurns: 3,
    rollingSummaryBytes: 500,
  });

  expect(plan).toEqual({ action: "stop" });
});

test("counts the rendered Rolling Summary envelope toward the budget", () => {
  const turns = [assistantTurn("t1", 100)];

  const plan = planFold(turns, {
    maxConversationBytes: 140,
    protectedRecentTurns: 3,
    rollingSummaryBytes: Buffer.byteLength(
      "Rolling Summary (earlier turns folded to stay within budget):\n" +
        "Prior narrative.",
      "utf8",
    ),
  });

  expect(plan).toEqual({ action: "stop" });
});

test("tolerates an oversized protected region when nothing has folded yet", () => {
  const turns = [
    ...turnWithObservation("t1", 8_000),
    ...turnWithObservation("t2", 8_000),
  ];

  const plan = planFold(turns, {
    maxConversationBytes: 4_000,
    protectedRecentTurns: 3,
    rollingSummaryBytes: 0,
  });

  expect(plan).toEqual({ action: "none" });
});

test("never splits a tool message from its assistant tool call across the fold boundary", () => {
  const turns = [
    ...turnWithObservation("t1", 5_000),
    ...turnWithObservation("t2", 500),
  ];

  const plan = planFold(turns, {
    maxConversationBytes: 4_000,
    protectedRecentTurns: 1,
    rollingSummaryBytes: 0,
  });

  expect(plan.action).toBe("fold");
  if (plan.action !== "fold") throw new Error("expected fold");
  for (const message of plan.foldTurns)
    if (message.role === "tool")
      expect(
        plan.foldTurns.some(
          (candidate) =>
            candidate.role === "assistant" &&
            candidate.toolCalls?.some((call) => call.id === message.toolCallId),
        ),
      ).toBe(true);
});

function turnWithObservation(id: string, bytes: number): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "read_file", input: {} }],
    },
    { role: "tool", toolCallId: id, content: "x".repeat(bytes) },
  ];
}

function assistantTurn(id: string, contentBytes: number): ModelMessage {
  return {
    role: "assistant",
    content: "x".repeat(contentBytes),
    toolCalls: [{ id, name: "read_file", input: {} }],
  };
}
