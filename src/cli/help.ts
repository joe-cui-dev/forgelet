export function helpText(): string {
  return `Forgelet

Usage:
  forge "<task>"
  forge --context issue.md "<task>"
  forge write --context draft.md "revise this"
  forge --live --budget 0.25 "<task>"
  forge --live --act "<task>"
  forge --model deepseek-v4-pro "<task>"
  forge --version | -v
  forge --budget 0.25 "<task>"
  forge config get
  forge config set <key> <value>
  forge config set activeContext.maxObservationBytes 16384
  forge sessions list
  forge sessions show <sessionId>
  forge explain <sessionId>
  forge memory suggest <sessionId>
  forge memory accept <suggestionId>

Forgelet V1 runs scaffolded Sessions by default. Use --live to run a real DeepSeek-backed Session. Add --act for coding runs that may request confirmed file edits and configured commands.

Writing runs return Critique, Revision, and Notes.
V1 config set supports memoryFile, activeContext.maxObservationBytes, and provider API key env vars.`;
}
