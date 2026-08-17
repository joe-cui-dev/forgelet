import type { PricingWindow, ReasoningEffort } from "../types.js";

export type { PricingWindow };

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
  /** The published off-peak rates. Peak rates are derived, never stored — see
   * `PEAK_RATE_MULTIPLIER`. */
  pricesUsdPerMillion: ModelPricesUsdPerMillion;
  timeOfDayPricing: "utc_peak_hours_2x";
  retired: boolean;
  replacement?: string;
}

/** Peak hours, as published: 01:00-04:00 and 06:00-10:00 UTC, with every other
 * hour off-peak. Two disjoint windows, not one — 04:00-06:00 UTC is an off-peak
 * gap between them. Half-open [start, end): a turn stamped exactly 04:00 is
 * off-peak. */
const PEAK_WINDOWS_UTC: readonly { startHour: number; endHour: number }[] = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
];

/** DeepSeek publishes off-peak rates as exactly half the peak rates. Storing
 * one rate set and this multiplier keeps that relationship an invariant rather
 * than a coincidence two hand-maintained tables must keep agreeing on. */
const PEAK_RATE_MULTIPLIER = 2;

// Facts verified against https://api-docs.deepseek.com on 2026-08-17, covering
// DeepSeek-V4-Pro-0813 and DeepSeek-V4-Flash-0731. Both are in-place updates:
// the API ids below are unchanged, so nothing in a request or response marks
// which weights answered. The increase DeepSeek had announced without a date
// landed on this date, and the peak-hour windows are now published as explicit
// UTC times, so time-of-day pricing is applied rather than treated as unknown.
// Prices below are the off-peak rates; peak rates are derived by doubling.
const deepSeekProfiles: readonly ModelProfile[] = [
  {
    id: "deepseek-v4-flash",
    protocols: ["chat_completions", "responses"],
    acceptedEfforts: ["none", "low", "high", "max"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricesUsdPerMillion: { inputCacheHit: 0.007, inputCacheMiss: 0.22, output: 0.66 },
    timeOfDayPricing: "utc_peak_hours_2x",
    retired: false,
  },
  {
    id: "deepseek-v4-pro",
    protocols: ["chat_completions"],
    acceptedEfforts: ["none", "low", "high", "max"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricesUsdPerMillion: { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
    timeOfDayPricing: "utc_peak_hours_2x",
    retired: false,
  },
  {
    id: "deepseek-chat",
    protocols: ["chat_completions"],
    acceptedEfforts: [],
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    pricesUsdPerMillion: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
    timeOfDayPricing: "utc_peak_hours_2x",
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
    timeOfDayPricing: "utc_peak_hours_2x",
    retired: true,
    replacement: "deepseek-v4-flash",
  },
];

/** Classifies an instant against the published peak windows. The instant must
 * be the provider's own timestamp wherever one is available: the windows are
 * facts about the provider's clock, and classifying them with a local clock
 * makes skew a silent mispricing at every window boundary. */
export function pricingWindowAt(instantMs: number): PricingWindow {
  return currentPeakWindow(instantMs) === undefined ? "off_peak" : "peak";
}

/** The rates in force at `instantMs`. A turn is priced at a single instant and
 * never split across a window boundary: the provider does not publish which
 * timestamp it bills on, so prorating a straddling turn would be precision we
 * have not earned. */
export function pricesAt(
  profile: ModelProfile,
  instantMs: number,
): ModelPricesUsdPerMillion {
  const offPeak = profile.pricesUsdPerMillion;
  if (pricingWindowAt(instantMs) === "off_peak") return offPeak;
  return {
    inputCacheHit: offPeak.inputCacheHit * PEAK_RATE_MULTIPLIER,
    inputCacheMiss: offPeak.inputCacheMiss * PEAK_RATE_MULTIPLIER,
    output: offPeak.output * PEAK_RATE_MULTIPLIER,
  };
}

/** When the peak window containing `instantMs` closes, or undefined if the
 * instant is already off-peak. Callers surface this so a reader can judge
 * whether waiting for the cheaper rate is worth it. */
export function peakWindowEndMs(instantMs: number): number | undefined {
  const window = currentPeakWindow(instantMs);
  if (!window) return undefined;
  return startOfUtcDayMs(instantMs) + window.endHour * MS_PER_HOUR;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function startOfUtcDayMs(instantMs: number): number {
  return Math.floor(instantMs / MS_PER_DAY) * MS_PER_DAY;
}

function currentPeakWindow(
  instantMs: number,
): { startHour: number; endHour: number } | undefined {
  const hoursIntoDay = (instantMs - startOfUtcDayMs(instantMs)) / MS_PER_HOUR;
  return PEAK_WINDOWS_UTC.find(
    (window) => hoursIntoDay >= window.startHour && hoursIntoDay < window.endHour,
  );
}

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
