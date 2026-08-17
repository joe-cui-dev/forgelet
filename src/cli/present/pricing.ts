import {
  DEEPSEEK_TIME_OF_DAY_PRICING,
  peakWindowEndMs,
  type TimeOfDayPricing,
} from "../../models/profiles.js";

/** The pre-launch peak-hour notice. Printed only inside a peak window, because
 * the decision it serves — wait for the cheaper rate — is one only a person can
 * take, and only before the Session starts. Naming when the window closes is
 * the point: "you are in peak hours" alone gives no way to judge whether
 * waiting is worth it, while "for another twelve minutes" does.
 *
 * Returns undefined off-peak, which is 17 of every 24 hours. */
export function formatPeakPricingNotice(
  instantMs: number = Date.now(),
  policy: TimeOfDayPricing = DEEPSEEK_TIME_OF_DAY_PRICING,
): string | undefined {
  const endsAtMs = peakWindowEndMs(policy, instantMs);
  if (endsAtMs === undefined) return undefined;
  return `DeepSeek peak hours until ${formatUtcClock(endsAtMs)} UTC — rates are ${policy.peakRateMultiplier}x off-peak.`;
}

/** Emits the notice before a Session that will really spend money. Every such
 * entry point calls this — a resumed Session buys turns at the same rates a
 * fresh one does, and `--preview` deliberately does not, since it spends
 * nothing. */
export function notifyPeakPricing(notify?: (text: string) => void): void {
  if (!notify) return;
  const notice = formatPeakPricingNotice();
  if (notice) notify(notice);
}

function formatUtcClock(instantMs: number): string {
  const at = new Date(instantMs);
  const hours = String(at.getUTCHours()).padStart(2, "0");
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
