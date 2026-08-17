import { peakWindowEndMs } from "../../models/profiles.js";

/** The pre-launch peak-hour notice. Printed only inside a peak window, because
 * the decision it serves — wait for the cheaper rate — is one only a person can
 * take, and only before the Session starts. Naming when the window closes is
 * the point: "you are in peak hours" alone gives no way to judge whether
 * waiting is worth it, while "for another twelve minutes" does.
 *
 * Returns undefined off-peak, which is 17 of every 24 hours. */
export function formatPeakPricingNotice(
  instantMs: number = Date.now(),
): string | undefined {
  const endsAtMs = peakWindowEndMs(instantMs);
  if (endsAtMs === undefined) return undefined;
  return `DeepSeek peak hours until ${formatUtcClock(endsAtMs)} UTC — rates are 2x off-peak.`;
}

function formatUtcClock(instantMs: number): string {
  const at = new Date(instantMs);
  const hours = String(at.getUTCHours()).padStart(2, "0");
  const minutes = String(at.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}
