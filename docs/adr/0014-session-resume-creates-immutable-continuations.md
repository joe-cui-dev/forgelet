# Session Resume Creates Immutable Continuations

Forgelet resumes prior work by creating a new **Session Continuation** instead of appending to or mutating the original **Session** Trace. This keeps each Session as one auditable run, allows branching continuation paths for alternate fixes or writing variants, and lets the new Session inherit compact **Continuation Context** from its own **Session Lineage** without replaying sibling branches or full historical transcripts.

Continuation inherits evidence, not authorization. Prior summaries, plans, changed files, verification attempts, risks, context attachment identity, and compacted observations can shape the next Active Context, but every new write, command, external effect, or other risky action must pass through the new Session's Permission Policy.
