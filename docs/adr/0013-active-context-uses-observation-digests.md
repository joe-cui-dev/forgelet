# Active Context Uses Observation Digests

Forgelet keeps the Trace metadata-first, but compacting old model-visible tool observations down to path and a thin summary makes dogfood Sessions re-read files and grow context again. Active Context compaction should therefore replace older large observations with deterministic Observation Digests that preserve useful facts such as source identity, range, hash, truncation state, and bounded excerpts, without turning the Trace into durable full-content storage or introducing model-generated semantic summaries as the V1 baseline.

The digest excerpt cap should be configurable separately from the total Active Context observation target. `activeContext.maxObservationBytes` remains the best-effort total working-set target, while `activeContext.observationDigestPreviewBytes` controls the per-digest excerpt size and should default conservatively, around 2048 UTF-8 bytes.

An Observation Digest should preserve the exact returned range shape. A compacted `read_file` observation keeps the original path, content hash, range kind, byte or line bounds, truncation state, continuation pointer, and a bounded excerpt from the content that was actually returned. A digest for `offsetBytes: 5000` must remain a digest of that returned slice, not a leading preview or whole-file summary.

The compacted tool message should keep the outer tool observation JSON shape and add a deterministic, model-readable `digest` string inside it. The JSON envelope keeps provider/tool-message contracts and tests stable, while the digest gives the model an obvious natural-language cue about what was compacted and where the bounded excerpt came from.
