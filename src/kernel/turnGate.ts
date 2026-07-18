import type {
  BudgetLimits,
  BudgetUsage,
  SessionStopReason,
} from "../types.js";
import type { ExecutionPolicy } from "./workflowDefinition.js";

export type TurnPlan =
  | { kind: "stop"; reason: SessionStopReason }
  | {
      kind: "turn";
      finalOnly: boolean;
      finalToolTurn: boolean;
      wrapupOnly: boolean;
      wrapupReason?: SessionStopReason;
      toolCallBlockReason: SessionStopReason;
      emptyContentStopReason: SessionStopReason;
    };

export const turnGate = (args: {
  usage: BudgetUsage;
  limits: BudgetLimits;
  elapsedWallClockMs: number;
  executionPolicy?: ExecutionPolicy;
  forcedStopReason?: SessionStopReason;
}): TurnPlan => {
  const stopReason = budgetStopReason(
    args.usage,
    args.limits,
    args.elapsedWallClockMs,
  );
  if (stopReason) return { kind: "stop", reason: stopReason };

  const isAnswerOnce = args.executionPolicy === "answer_once";
  const remainingModelTurns = args.limits.maxModelTurns - args.usage.modelTurns;
  const finalOnly = isAnswerOnce || remainingModelTurns === 1;
  const wrapupReason = finalOnly
    ? undefined
    : (args.forcedStopReason ??
      budgetWrapupStopReason(
        args.usage,
        args.limits,
        args.elapsedWallClockMs,
      ));
  return {
    kind: "turn",
    finalOnly,
    finalToolTurn: !isAnswerOnce && remainingModelTurns === 2,
    wrapupOnly: finalOnly || wrapupReason !== undefined,
    wrapupReason,
    toolCallBlockReason:
      wrapupReason ??
      (isAnswerOnce ? "answer_once_tool_calls_blocked" : "max_model_turns"),
    emptyContentStopReason: wrapupReason ?? "max_model_turns",
  };
};

export const budgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
  elapsedWallClockMs: number,
): SessionStopReason | undefined => {
  if (usage.modelTurns >= limits.maxModelTurns) return "max_model_turns";
  if (elapsedWallClockMs >= limits.maxWallClockMs)
    return "wall_clock_limit_exceeded";
  return costBudgetStopReason(usage, limits);
};

export const costBudgetStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
): SessionStopReason | undefined => {
  if (usage.estimatedCostUsd >= limits.maxEstimatedCostUsd)
    return "estimated_cost_budget_exceeded";
  return undefined;
};

export const BUDGET_WRAPUP_RESERVE_FRACTION = 0.9;

export const budgetWrapupStopReason = (
  usage: BudgetUsage,
  limits: BudgetLimits,
  elapsedWallClockMs: number,
): SessionStopReason | undefined => {
  if (
    usage.estimatedCostUsd >=
    limits.maxEstimatedCostUsd * BUDGET_WRAPUP_RESERVE_FRACTION
  )
    return "estimated_cost_budget_exceeded";
  if (
    elapsedWallClockMs >=
    limits.maxWallClockMs * BUDGET_WRAPUP_RESERVE_FRACTION
  )
    return "wall_clock_limit_exceeded";
  return undefined;
};
