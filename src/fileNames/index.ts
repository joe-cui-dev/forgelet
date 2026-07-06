export function formatLocalTimestampForFilename(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    "_",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

export function sessionTraceFileName(sessionId: string, date: Date): string {
  return `${formatLocalTimestampForFilename(date)}_${sessionId}.jsonl`;
}

const pad2 = (value: number): string => String(value).padStart(2, "0");
