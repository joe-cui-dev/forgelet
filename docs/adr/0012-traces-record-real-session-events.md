# Traces Record Real Session Events

Forgelet traces are evidence for reviewing, explaining, and learning from a Session, so they must record events that actually occurred rather than simulated workflow progress. During early kernel skeleton work, a Session may only advance through intake and final summary; Forgelet should not emit fake model turns, tool calls, permission decisions, or completed workflow stages just to make the trace look complete. Context attachments should be recorded by provenance, size, hash, and short preview unless the user explicitly chooses fuller persistence.

Read-only tool results may provide full content to the active model turn as an observation, but the Trace should persist only evidence metadata such as path, byte count, hash, status, and a short preview. The Trace should not become hidden durable storage for full source files, command output, page text, or other large context.

A Session finish event should distinguish successful completion from controlled stops and failures. Budget exhaustion and max-turn exhaustion should finish with a stopped status and a specific reason such as `budget_exceeded` or `max_model_turns`, not with completed or failed.
