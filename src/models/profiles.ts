import type { PricingWindow, ReasoningEffort } from "../types.js";

export interface ModelPricesUsdPerMillion {
  inputCacheHit: number;
  inputCacheMiss: number;
  output: number;
}

/** A half-open [start, end) span of UTC hours. Half-open is what makes the
 * published boundaries unambiguous: a turn stamped exactly 04:00 is off-peak. */
export interface PeakWindow {
  startHourUtc: number;
  endHourUtc: number;
}

/** A provider's published time-of-day price split. The windows live here, on
 * the policy a Profile carries, rather than in a marker string the pricing
 * functions ignore — a Profile that states a policy must be the thing that
 * decides its own rates, or the statement is decoration. */
export interface TimeOfDayPricing {
  peakWindowsUtc: readonly PeakWindow[];
  peakRateMultiplier: number;
}

/** DeepSeek's published policy: peak hours 01:00-04:00 and 06:00-10:00 UTC,
 * every other hour off-peak, off-peak rates exactly half the peak rates. Two
 * disjoint windows, not one — 04:00-06:00 UTC is an off-peak gap between them.
 * Holding the multiplier here keeps "off-peak is half of peak" an invariant
 * rather than a coincidence two hand-maintained rate tables must keep agreeing
 * on. Every DeepSeek Profile shares this one object, so the CLI can report the
 * policy without first resolving a Route. */
export const DEEPSEEK_TIME_OF_DAY_PRICING: TimeOfDayPricing = {
  peakWindowsUtc: [
    { startHourUtc: 1, endHourUtc: 4 },
    { startHourUtc: 6, endHourUtc: 10 },
  ],
  peakRateMultiplier: 2,
};

export interface ModelProfile {
  id: string;
  protocols: readonly ("chat_completions" | "responses")[];
  acceptedEfforts: readonly ReasoningEffort[];
  contextWindowTokens: number;
  maxOutputTokens: number;
  /** The published off-peak rates. Peak rates are derived from
   * `timeOfDayPricing`, never stored. */
  pricesUsdPerMillion: ModelPricesUsdPerMillion;
  timeOfDayPricing: TimeOfDayPricing;
  retired: boolean;
  replacement?: string;
}

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
    timeOfDayPricing: DEEPSEEK_TIME_OF_DAY_PRICING,
    retired: false,
  },
  {
    id: "deepseek-v4-pro",
    protocols: ["chat_completions"],
    acceptedEfforts: ["none", "low", "high", "max"],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    pricesUsdPerMillion: { inputCacheHit: 0.022, inputCacheMiss: 0.66, output: 1.98 },
    timeOfDayPricing: DEEPSEEK_TIME_OF_DAY_PRICING,
    retired: false,
  },
  {
    id: "deepseek-chat",
    protocols: ["chat_completions"],
    acceptedEfforts: [],
    contextWindowTokens: 0,
    maxOutputTokens: 0,
    pricesUsdPerMillion: { inputCacheHit: 0, inputCacheMiss: 0, output: 0 },
    timeOfDayPricing: DEEPSEEK_TIME_OF_DAY_PRICING,
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
    timeOfDayPricing: DEEPSEEK_TIME_OF_DAY_PRICING,
    retired: true,
    replacement: "deepseek-v4-flash",
  },
];

/** Classifies an instant against a policy's peak windows. The instant must be
 * the provider's own timestamp wherever one is available: the windows are facts
 * about the provider's clock, and classifying them with a local clock makes
 * skew a silent mispricing at every window boundary. */
export function pricingWindowAt(
  policy: TimeOfDayPricing,
  instantMs: number,
): PricingWindow {
  return currentPeakWindow(policy, instantMs) === undefined ? "off_peak" : "peak";
}

/** The rates in force for `profile` at `instantMs`, decided by the profile's
 * own time-of-day policy. A turn is priced at a single instant and never split
 * across a window boundary: the provider does not publish which timestamp it
 * bills on, so prorating a straddling turn would be precision we have not
 * earned. Always returns a fresh object — the catalog's own rates are never
 * handed out for a caller to mutate. */
export function pricesAt(
  profile: ModelProfile,
  instantMs: number,
): ModelPricesUsdPerMillion {
  const offPeak = profile.pricesUsdPerMillion;
  const multiplier =
    pricingWindowAt(profile.timeOfDayPricing, instantMs) === "peak"
      ? profile.timeOfDayPricing.peakRateMultiplier
      : 1;
  return {
    inputCacheHit: offPeak.inputCacheHit * multiplier,
    inputCacheMiss: offPeak.inputCacheMiss * multiplier,
    output: offPeak.output * multiplier,
  };
}

/** When the peak window containing `instantMs` closes, or undefined if the
 * instant is already off-peak. Callers surface this so a reader can judge
 * whether waiting for the cheaper rate is worth it. */
export function peakWindowEndMs(
  policy: TimeOfDayPricing,
  instantMs: number,
): number | undefined {
  const window = currentPeakWindow(policy, instantMs);
  if (!window) return undefined;
  return startOfUtcDayMs(instantMs) + window.endHourUtc * MS_PER_HOUR;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function startOfUtcDayMs(instantMs: number): number {
  return Math.floor(instantMs / MS_PER_DAY) * MS_PER_DAY;
}

function currentPeakWindow(
  policy: TimeOfDayPricing,
  instantMs: number,
): PeakWindow | undefined {
  const hoursIntoDay = (instantMs - startOfUtcDayMs(instantMs)) / MS_PER_HOUR;
  return policy.peakWindowsUtc.find(
    (window) =>
      hoursIntoDay >= window.startHourUtc && hoursIntoDay < window.endHourUtc,
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
