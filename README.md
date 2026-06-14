# Forgelet

Forgelet is a local-first CLI coding agent for small repository tasks.

V1 starts with a TypeScript/Node.js CLI scaffold and grows toward a permissioned agent loop that can search, read, patch, test, trace, and explain its work.

## Local Development

```bash
npm install
npm run build
npm test
npm link
forge "fix this bug"
```

## V1 Command Shape

```bash
forge "<task>"
forge --context issue.md "<task>"
forge --model deepseek-v4-pro "<task>"
forge --budget 0.25 "<task>"
forge config get
forge config set defaultModel deepseek-v4-pro
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
```

The current scaffold implements parsing and a placeholder agent response. The real tool registry, trace writer, permission policy, and model providers will be filled in by the V1 implementation issues.
