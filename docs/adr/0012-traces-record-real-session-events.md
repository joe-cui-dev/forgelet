# Traces Record Real Session Events

Forgelet traces are evidence for reviewing, explaining, and learning from a Session, so they must record events that actually occurred rather than simulated workflow progress. During early kernel skeleton work, a Session may only advance through intake and final summary; Forgelet should not emit fake model turns, tool calls, permission decisions, or completed workflow stages just to make the trace look complete. Context attachments should be recorded by provenance, size, hash, and short preview unless the user explicitly chooses fuller persistence.
