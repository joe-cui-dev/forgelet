import { expect, test } from "@jest/globals";
import {
  DEEPSEEK_TIME_OF_DAY_PRICING as policy,
  modelProfile,
  peakWindowEndMs,
  pricesAt,
  pricingWindowAt,
} from "../../src/models/profiles.js";
import { utc } from "../testSupport/utc.js";

test("published peak windows classify instants as peak or off-peak", () => {
  expect(pricingWindowAt(policy, utc(0, 59))).toBe("off_peak");
  expect(pricingWindowAt(policy, utc(1, 0))).toBe("peak");
  expect(pricingWindowAt(policy, utc(3, 59))).toBe("peak");
  expect(pricingWindowAt(policy, utc(4, 0))).toBe("off_peak");
  expect(pricingWindowAt(policy, utc(5, 30))).toBe("off_peak");
  expect(pricingWindowAt(policy, utc(6, 0))).toBe("peak");
  expect(pricingWindowAt(policy, utc(9, 59))).toBe("peak");
  expect(pricingWindowAt(policy, utc(10, 0))).toBe("off_peak");
  expect(pricingWindowAt(policy, utc(23, 30))).toBe("off_peak");
});

test("the 04:00-06:00 UTC gap between the two peak windows is off-peak", () => {
  for (let minute = 0; minute < 120; minute += 15)
    expect(pricingWindowAt(policy, utc(4, minute))).toBe("off_peak");
});

test("every profile carries the policy that decides its own rates", () => {
  const flash = modelProfile("deepseek-v4-flash");
  if (!flash) throw new Error("missing flash profile");
  // A profile whose policy has no peak windows is priced flat — proving the
  // rates follow the profile's policy rather than a module-level constant.
  const flatRated = { ...flash, timeOfDayPricing: { peakWindowsUtc: [], peakRateMultiplier: 2 } };
  expect(pricesAt(flatRated, utc(2))).toEqual(flash.pricesUsdPerMillion);
  expect(pricesAt(flash, utc(2))).not.toEqual(flash.pricesUsdPerMillion);
});

test("pricesAt never hands out the catalog's own rate object", () => {
  const flash = modelProfile("deepseek-v4-flash");
  if (!flash) throw new Error("missing flash profile");
  const offPeak = pricesAt(flash, utc(12));
  expect(offPeak).not.toBe(flash.pricesUsdPerMillion);
  offPeak.output = 999;
  expect(flash.pricesUsdPerMillion.output).toBe(0.66);
});

test("profile prices are the published off-peak rates", () => {
  const flash = modelProfile("deepseek-v4-flash");
  expect(flash?.pricesUsdPerMillion).toEqual({
    inputCacheHit: 0.007,
    inputCacheMiss: 0.22,
    output: 0.66,
  });
  const pro = modelProfile("deepseek-v4-pro");
  expect(pro?.pricesUsdPerMillion).toEqual({
    inputCacheHit: 0.022,
    inputCacheMiss: 0.66,
    output: 1.98,
  });
});

test("peak rates are exactly twice the off-peak rates", () => {
  for (const model of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
    const profile = modelProfile(model);
    if (!profile) throw new Error(`missing profile for ${model}`);
    const offPeak = pricesAt(profile, utc(12));
    const peak = pricesAt(profile, utc(2));
    expect(offPeak).toEqual(profile.pricesUsdPerMillion);
    expect(peak.inputCacheHit).toBeCloseTo(offPeak.inputCacheHit * 2, 10);
    expect(peak.inputCacheMiss).toBeCloseTo(offPeak.inputCacheMiss * 2, 10);
    expect(peak.output).toBeCloseTo(offPeak.output * 2, 10);
  }
});

test("peak window end reports when the current peak window closes", () => {
  expect(peakWindowEndMs(policy, utc(2, 30))).toBe(utc(4));
  expect(peakWindowEndMs(policy, utc(1))).toBe(utc(4));
  expect(peakWindowEndMs(policy, utc(9, 59))).toBe(utc(10));
  expect(peakWindowEndMs(policy, utc(12))).toBeUndefined();
  expect(peakWindowEndMs(policy, utc(5))).toBeUndefined();
});
