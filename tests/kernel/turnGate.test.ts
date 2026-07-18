import { expect, test } from "@jest/globals";
import { turnGate } from "../../src/kernel/turnGate.js";
import type { BudgetLimits, BudgetUsage } from "../../src/types.js";

const limits: BudgetLimits = {
  maxModelTurns: 10,
  maxEstimatedCostUsd: 10,
  maxWallClockMs: 1_000,
};

const usage = (overrides: Partial<BudgetUsage> = {}): BudgetUsage => ({
  modelTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  unpricedTurns: 0,
  ...overrides,
});

test.each([
  ["model turns", usage({ modelTurns: 10 }), 0, "max_model_turns"],
  ["estimated cost", usage({ estimatedCostUsd: 10 }), 0, "estimated_cost_budget_exceeded"],
  ["wall clock", usage(), 1_000, "wall_clock_limit_exceeded"],
])("stops when the %s budget is exhausted", (_label, currentUsage, elapsedWallClockMs, reason) => {
  expect(turnGate({ usage: currentUsage, limits, elapsedWallClockMs })).toEqual({
    kind: "stop",
    reason,
  });
});

test("reserves a wrap-up-only turn when estimated cost crosses 90 percent", () => {
  expect(
    turnGate({
      usage: usage({ estimatedCostUsd: 9 }),
      limits,
      elapsedWallClockMs: 0,
    }),
  ).toEqual({
    kind: "turn",
    finalOnly: false,
    finalToolTurn: false,
    wrapupOnly: true,
    wrapupReason: "estimated_cost_budget_exceeded",
    toolCallBlockReason: "estimated_cost_budget_exceeded",
    emptyContentStopReason: "estimated_cost_budget_exceeded",
  });
});

test("reserves a final-only turn with one model turn remaining", () => {
  expect(
    turnGate({ usage: usage({ modelTurns: 9 }), limits, elapsedWallClockMs: 0 }),
  ).toEqual({
    kind: "turn",
    finalOnly: true,
    finalToolTurn: false,
    wrapupOnly: true,
    wrapupReason: undefined,
    toolCallBlockReason: "max_model_turns",
    emptyContentStopReason: "max_model_turns",
  });
});

test("marks the preceding turn as the final tool-capable turn", () => {
  expect(
    turnGate({ usage: usage({ modelTurns: 8 }), limits, elapsedWallClockMs: 0 }),
  ).toMatchObject({
    kind: "turn",
    finalOnly: false,
    finalToolTurn: true,
    wrapupOnly: false,
  });
});

test("answer-once is final-only and blocks tool calls with its dedicated reason", () => {
  expect(
    turnGate({
      usage: usage(),
      limits,
      elapsedWallClockMs: 0,
      executionPolicy: "answer_once",
    }),
  ).toEqual({
    kind: "turn",
    finalOnly: true,
    finalToolTurn: false,
    wrapupOnly: true,
    wrapupReason: undefined,
    toolCallBlockReason: "answer_once_tool_calls_blocked",
    emptyContentStopReason: "max_model_turns",
  });
});

test("forced stop takes priority over the reserve threshold and precomputed reasons", () => {
  expect(
    turnGate({
      usage: usage({ estimatedCostUsd: 9 }),
      limits,
      elapsedWallClockMs: 950,
      forcedStopReason: "user_stopped",
    }),
  ).toEqual({
    kind: "turn",
    finalOnly: false,
    finalToolTurn: false,
    wrapupOnly: true,
    wrapupReason: "user_stopped",
    toolCallBlockReason: "user_stopped",
    emptyContentStopReason: "user_stopped",
  });
});
