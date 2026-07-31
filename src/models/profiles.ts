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
    acceptedEfforts: ["none", "high", "max"],
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
