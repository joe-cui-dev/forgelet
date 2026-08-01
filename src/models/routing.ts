import type { ForgeletConfig } from "../config/index.js";
import type { WorkflowKind } from "../types.js";
import type { ReasoningEffort } from "../types.js";
import { modelProfile } from "./profiles.js";

const BYTES_PER_TOKEN = 4;
const OUTPUT_BUDGET_FRACTION = 0.25;
const OBSERVATION_BUDGET_FRACTION = 0.125;
// The limit every read-only tool carried as a constant while the conversation
// budget was a flat 128KB. It stays the floor so workflows whose budget did not
// grow keep their current reads.
const MIN_OBSERVATION_BYTES = 20 * 1024;

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
  return Math.min(
    config.routing[workflow].maxConversationBytes ??
      config.activeContext.maxConversationBytes,
    config.activeContext.maxConversationBytes,
  );
}

/** How many bytes one tool observation may return. Derived from the route's
 * conversation budget so a single read cannot dominate the active context: at
 * one eighth, eight full-size reads still fit before folding is in question. */
export function maxObservationBytesForRoute(
  config: Pick<ForgeletConfig, "routing" | "activeContext">,
  workflow: WorkflowKind,
): number {
  return Math.max(
    MIN_OBSERVATION_BYTES,
    Math.floor(
      maxConversationBytesForRoute(config, workflow) *
        OBSERVATION_BUDGET_FRACTION,
    ),
  );
}

export function maxOutputTokensForRoute(
  config: Pick<ForgeletConfig, "routing" | "activeContext">,
  workflow: WorkflowKind,
  model: string,
): number {
  const derived = Math.floor(
    maxConversationBytesForRoute(config, workflow) /
      BYTES_PER_TOKEN *
      OUTPUT_BUDGET_FRACTION,
  );
  const ceiling = modelProfile(model)?.maxOutputTokens;
  return ceiling === undefined ? derived : Math.min(derived, ceiling);
}

export function modelRunnability(
  model: string,
  effort?: ReasoningEffort,
): { runnable: true } | { runnable: false; errorMessage: string; previewReason: string } {
  const profile = modelProfile(model);
  if (profile?.retired)
    return {
      runnable: false,
      errorMessage: `Model ${model} was retired. Migrate to ${profile.replacement ?? "a supported model"}.`,
      previewReason: `model ${model} was retired; migrate to ${profile.replacement ?? "a supported model"}.`,
    };
  if (profile && (!effort || profile.acceptedEfforts.includes(effort))) return { runnable: true };
  if (profile && effort)
    return {
      runnable: false,
      errorMessage: `Model ${model} does not accept reasoning effort ${effort}.`,
      previewReason: `model ${model} does not accept reasoning effort ${effort}.`,
    };
  if (model.startsWith("deepseek-"))
    return {
      runnable: false,
      errorMessage: `Unknown DeepSeek model ${model}; select a profiled model before spending.`,
      previewReason: `unknown DeepSeek model ${model}; it is not runnable.`,
    };
  return {
    runnable: false,
    errorMessage: `Model-backed execution currently supports DeepSeek models only. Route selected ${model}.`,
    previewReason: `model-backed execution currently supports DeepSeek routes only; ${model} is not runnable.`,
  };
}
