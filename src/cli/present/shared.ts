export function formatList(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}
