# Trace Projection Stays with the Trace Vocabulary

Tool Observations are the shared currency of model-facing conversations, Observation Digests, Fact Ledgers, and Trace evidence. The observation module owns the intake and projection shape that makes one tool result usable in those contexts, but the selection of which observation metadata becomes Trace evidence has a different owner: the Trace Vocabulary.

We decided that the Trace module owns `TRACED_OBSERVATION_KEYS`, the payload type derived from that key table, and the projection function that builds a `tool_result` event. The dependency is one-way from Trace to observation. The key table is intentionally adjacent to the Trace event vocabulary so an auditor can see both the evidence retained from an observation and the policy that deliberately omits its content and web metadata. This preserves the closed, additive vocabulary from ADR 0059 without making the observation module audit-policy aware.

We rejected placing the Trace projection in the observation module. That would make a generic shared module decide audit policy and would hide a meaningful part of the Trace Vocabulary behind a caller-facing implementation detail. We also rejected copying the key list at the tool-call site: a second list would restore the drift that this refactor removes.
