/** A UTC instant on 2026-08-17, expressed by hour and minute. The date is
 * arbitrary and fixed; only the time of day matters to peak-window tests. */
export const utc = (hour: number, minute = 0): number =>
  Date.UTC(2026, 7, 17, hour, minute);
