import type { MemorySuggestion } from "../../types.js";

export function formatMemorySuggestion(suggestion: MemorySuggestion): string {
  return [
    `Memory suggestion: ${suggestion.id}`,
    `Source Session: ${suggestion.sourceSessionId}`,
    `Status: ${suggestion.status}`,
    `Reason: ${suggestion.reason}`,
    suggestion.text,
  ].join("\n");
}

export function formatAcceptedMemory(suggestion: MemorySuggestion): string {
  return [
    `Memory accepted: ${suggestion.id}`,
    `Source Session: ${suggestion.sourceSessionId}`,
  ].join("\n");
}
