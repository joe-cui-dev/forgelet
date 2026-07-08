# Bounded Retry for Transient Model-Turn Errors

The main model-turn call in the ReAct Node (`runReactNode`) had no retry: a transient network
error or a provider 429/5xx threw immediately, failing the whole Session with
`model_execution_error` and discarding all turns of work so far. This is fatal for the planned
Background Sessions, where nobody is present to re-run a failed Session by hand. We now retry
the main turn call up to 2 times with exponential backoff and jitter, but only for errors
classified as transient; non-retryable errors still throw immediately on the first attempt.

Classification prioritizes `statusCode` when the error carries one: a received HTTP response
means the request reached the provider, so only 429 and 5xx are treated as transient, and any
other status (auth, validation) fails fast. When no `statusCode` is present, classification
falls back to `causeCategory` (set by provider clients such as DeepSeek's): network/timeout
categories (`request_error`, `response_aborted`, `response_aborted_empty_body`,
`response_error`, `timeout`) are transient; malformed-response categories
(`invalid_json`, `invalid_stream`) are not, since retrying a bad parse will not fix it.

Every retry appends a `model_turn_retry` Trace event (attempt number, max retries, delay, and
the failed attempt's error payload) and a matching Debug Transcript entry, so retries remain
visible evidence rather than silent workarounds (ADR 0012). Retry count and base delay are
hardcoded constants in `src/kernel/reactNode.ts`, not user config, since there is no evidence
yet that per-workflow tuning is needed.

The conversation-fold model call (`attemptConversationFold`) already has its own failure
tolerance — a failed fold retries once next turn, then falls back to a Degraded Fold (ADR
0022) — and is deliberately left untouched by this change; folding and the main turn call are
different operations with different existing safety nets.

## Considered Options

- **No retry (status quo)** — simplest, but discards Session progress on any transient blip,
  which is unacceptable once Background Sessions run unattended.
- **Retry all errors uniformly** — simpler classification, but would blindly retry
  auth/validation failures and malformed responses that can never succeed, wasting the retry
  budget and delaying an unavoidable failure.
- **Bounded retry with transient-only classification (chosen)** — costs a small classification
  function, but avoids retrying errors that cannot self-resolve and keeps the retry budget for
  genuine transient failures.

## Consequences

Sessions now tolerate up to 2 consecutive transient model-turn failures before failing, at the
cost of added latency (bounded by the backoff schedule) only on the failure path. Retry
behavior is invisible when the model client succeeds on the first attempt, so all existing
tests pass unchanged.
