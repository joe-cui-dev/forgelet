import type { ForgeletConfig } from "../config/index.js";
import type { WorkflowKind } from "../types.js";

export function providerForModel(
  model: string,
  config: Pick<ForgeletConfig, "providers">,
): { name: string; apiKeyEnv: string } {
  if (model.startsWith("deepseek-")) {
    return { name: "deepseek", apiKeyEnv: config.providers.deepseek.apiKeyEnv };
  }
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  ) {
    return { name: "openai", apiKeyEnv: config.providers.openai.apiKeyEnv };
  }
  if (model.startsWith("claude-")) {
    return { name: "anthropic", apiKeyEnv: config.providers.anthropic.apiKeyEnv };
  }
  return { name: "unknown", apiKeyEnv: "unknown" };
}

export function maxConversationBytesForRoute(
  config: Pick<ForgeletConfig, "routing" | "activeContext">,
  workflow: WorkflowKind,
): number {
  return (
    config.routing[workflow].maxConversationBytes ??
    config.activeContext.maxConversationBytes
  );
}

export function modelRunnability(
  model: string,
): { runnable: true } | { runnable: false; errorMessage: string; previewReason: string } {
  if (model.startsWith("deepseek-")) return { runnable: true };
  return {
    runnable: false,
    errorMessage: `Model-backed execution currently supports DeepSeek models only. Route selected ${model}.`,
    previewReason: `model-backed execution currently supports DeepSeek routes only; ${model} is not runnable.`,
  };
}
