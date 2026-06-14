export function helpText(): string {
  return `Forgelet

Usage:
  forge "<task>"
  forge --context issue.md "<task>"
  forge --model deepseek-v4-pro "<task>"
  forge --budget 0.25 "<task>"
  forge config get
  forge config set <key> <value>
  forge sessions list
  forge sessions show <sessionId>
  forge explain <sessionId>

Forgelet V1 is currently scaffolded. The real agent loop, tools, trace, config, and model providers will be implemented incrementally.`;
}
