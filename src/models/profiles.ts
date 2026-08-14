import type { ReasoningEffort } from "../types.js";

export interface ModelPricesUsdPerMillion {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

export interface ModelProfile {
  id: string;
  protocols: readonly ("chat_completions" | "responses")[];
  acceptedEfforts: readonly ReasoningEffort[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  pricesUsdPerMillion: ModelPricesUsdPerMillion;
  timeOfDayPricing: "undated_peak_hours_2x";
  retired: boolean;
  replacement?: string;
}

// Facts verified against https://api-docs.deepseek.com on 2026-08-13, covering
// DeepSeek-V4-Pro-0813 and DeepSeek-V4-Flash-0731. Both are in-place updates:
// the API ids below are unchanged, so nothing in a request or response marks
// which weights answered. Prices are the rates published on that date, and
// DeepSeek has announced a planned significant increase — these figures, and
// every budget estimate derived from them, go stale with no API-visible signal.
const deepSeekProfiles: readonly ModelProfile[] = [
  {
    id: "deepseek-v4-flash",
    protocols: ["chat_completions", "responses"],
    acceptedEfforts: ["none", "low", "high", "max"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricesUsdPerMillion: { inputCacheHit: 0.0028, inputCacheMiss: 0.14, output: 0.28 },
    timeOfDayPricing: "undated_peak_hours_2x",
    retired: false,
  },
  {
    id: "deepseek-v4-pro",
    protocols: ["chat_completions"],
    acceptedEfforts: ["none", "low", "high", "max"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricesUsdPerMillion: { inputCacheHit: 0.003625, inputCacheMiss: 0.435, output: 0.87 },
    timeOfDayPricing: "undated_peak_hours_2x",
    retired: false,
  },
  {
    id: "deepseek-chat",
    protocols: ["chat_completions"],
    acceptedEfforts: [],
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    pricesUsdPerMillion: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
    timeOfDayPricing: "undated_peak_hours_2x",
    retired: true,
    replacement: "deepseek-v4-flash",
  },
  {
    id: "deepseek-reasoner",
    protocols: ["chat_completions"],
    acceptedEfforts: [],
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    pricesUsdPerMillion: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
    timeOfDayPricing: "undated_peak_hours_2x",
    retired: true,
    replacement: "deepseek-v4-flash",
  },
];

export function modelProfile(model: string): ModelProfile | undefined {
  return deepSeekProfiles.find((profile) => profile.id === model);
}

export function isKnownDeepSeekModel(model: string): boolean {
  return modelProfile(model) !== undefined;
}

/** Model ids that may be selected for a new Route. Retired profiles remain
 * known so routing can offer their migration guidance, but they cannot be
 * chosen by a Browser Workbench invocation. */
export function routableModelIds(): ReadonlySet<string> {
  return new Set(deepSeekProfiles.filter((profile) => !profile.retired).map((profile) => profile.id));
}
