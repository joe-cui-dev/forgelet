# Debug Transcripts Stay Separate From Traces

Forgelet will expose full agent-model exchanges through an explicit `--debug` mode that writes a local Debug Transcript under `.forgelet/debug/<sessionId>.jsonl`. The Trace will record only Debug Transcript discovery and integrity metadata, such as path, hash, and byte count, because Trace remains audit evidence and should not become durable storage for full prompts, context attachments, model responses, tool observations, browser text, Durable Memory, or private writing style material.
