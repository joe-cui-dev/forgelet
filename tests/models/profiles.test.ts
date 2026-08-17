import { expect, test } from "@jest/globals";
import {
  modelProfile,
  peakWindowEndMs,
  pricesAt,
  pricingWindowAt,
} from "../../src/models/profiles.js";

/** A UTC instant on 2026-08-17, expressed by hour and minute. */
const utc = (hour: number, minute = 0): number =>
  Date.UTC(2026, 7, 17, hour, minute);

test("published peak windows classify instants as peak or off-peak", () => {
  expect(pricingWindowAt(utc(0, 59))).toBe("off_peak");
  expect(pricingWindowAt(utc(1, 0))).toBe("peak");
  expect(pricingWindowAt(utc(3, 59))).toBe("peak");
  expect(pricingWindowAt(utc(4, 0))).toBe("off_peak");
  expect(pricingWindowAt(utc(5, 30))).toBe("off_peak");
  expect(pricingWindowAt(utc(6, 0))).toBe("peak");
  expect(pricingWindowAt(utc(9, 59))).toBe("peak");
  expect(pricingWindowAt(utc(10, 0))).toBe("off_peak");
  expect(pricingWindowAt(utc(23, 30))).toBe("off_peak");
});

test("the 04:00-06:00 UTC gap between the two peak windows is off-peak", () => {
  for (let minute = 0; minute < 120; minute += 15)
    expect(pricingWindowAt(utc(4, minute))).toBe("off_peak");
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
  expect(peakWindowEndMs(utc(2, 30))).toBe(utc(4));
  expect(peakWindowEndMs(utc(1))).toBe(utc(4));
  expect(peakWindowEndMs(utc(9, 59))).toBe(utc(10));
  expect(peakWindowEndMs(utc(12))).toBeUndefined();
  expect(peakWindowEndMs(utc(5))).toBeUndefined();
});
