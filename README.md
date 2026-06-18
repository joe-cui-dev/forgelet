# Forgelet

Forgelet is a local-first personal agent kernel with a CLI as its first surface.

V1 starts with a TypeScript/Node.js CLI scaffold and grows toward permissioned workflow graphs. The first usable workflow is coding: search, read, patch, test, trace, and explain. V1 also includes a lightweight writing workflow skeleton so the kernel does not become coding-specific.

## Local Development

```bash
npm install
npm run build
npm test
npm link
forge "fix this bug"
```

For local DeepSeek smoke testing, copy `.env.example` to `.env`, fill in `DEEPSEEK_API_KEY`, and run:

```bash
npm run smoke:deepseek
```

`DEEPSEEK_MODEL` is only used by the smoke test. Live Session defaults are defined in `src/config/index.ts`; choose a different model for one run with `--model`:

```bash
forge --live --model deepseek-v4-pro --budget 0.10 "inspect this repo"
```

## V1 Command Shape

```bash
forge "<task>"
forge --context issue.md "<task>"
forge write --context draft.md "revise this"
forge --live --budget 0.25 "<task>"
forge --model deepseek-v4-pro "<task>"
forge --budget 0.25 "<task>"
forge config get
forge config set memoryFile .forgelet/memory.md
forge sessions list
forge sessions show <sessionId>
forge explain <sessionId>
forge memory suggest <sessionId>
forge memory accept <suggestionId>
```

The current scaffold implements parsing and a placeholder agent response. The real tool registry, trace writer, permission policy, and model providers will be filled in by the V1 implementation issues.
