# Memory Persistence Requires User Approval

Forgelet V1 will generate Memory Suggestions from traces and explanations, but it will not silently write Durable Memory. This keeps the project useful as a learning tool without letting one flawed run pollute future behavior. Durable Memory writes happen only after explicit user acceptance, and accepted entries should keep provenance back to the source session or trace.
