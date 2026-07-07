---
name: verify
description: Build, launch, and drive the forge CLI against a scratch workspace to verify changes at the real surface. Use when verifying any Forgelet behavior change end-to-end.
---

# Verifying Forgelet at the CLI surface

## Build & launch

```bash
npm run build                      # tsc → dist/; bin is dist/cli/index.js
node dist/cli/index.js code --debug --budget 0.40 "<task>"
```

Requires `.env` with `DEEPSEEK_API_KEY` (+ optional `DEEPSEEK_MODEL`) in the
**cwd you run from** — copy the repo root `.env` into the scratch workspace.

## Scratch workspace pattern

Run from a throwaway dir so `.forgelet/` state stays isolated:

```bash
mkdir -p ws/.forgelet && cp .env ws/ && cd ws
printf '{"activeContext":{"maxConversationBytes":4096,"observationDigestPreviewBytes":900}}' \
  > .forgelet/config.json
```

- `maxConversationBytes` min is 4096 — smallest budget, triggers compaction/folds fast.
- Fat `observationDigestPreviewBytes` makes digests less effective → forces folds sooner.

## Evidence locations

- **Trace**: `ws/.forgelet/sessions/<sessionId>.jsonl` — events:
  `conversation_compacted` / `conversation_folded` / `conversation_fold_failed` /
  `conversation_fold_stopped` / `conversation_fold_narrative_clipped`.
- **Debug transcript** (needs `--debug`): `ws/.forgelet/debug/<sessionId>.jsonl` —
  full model-facing messages; fold calls have `payload.purpose == "conversation_fold"`;
  the rolling summary message starts with `Rolling Summary (earlier turns folded`.

## Driving multi-turn behavior

The model batches tool calls, which keeps turn count low. To force many turns,
instruct explicitly: “每个回合只调用一个工具，绝不并行，按顺序逐个读取 …”.
Default model-turn cap is 12 — folds only happen past `protectedRecentTurns` (3),
so ~8 folded turns max per session; size probe fixtures accordingly (long
filenames inflate Fact Ledger entry bytes if you need ledger eviction).

## Gotchas

- Fold uses the **same model client** as the session — degraded-fold (summarizer
  failure) cannot be fault-injected at the CLI surface; it's unit-test territory.
- `forge` CLI prints the trace path on the last line of every session.
