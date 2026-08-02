# Verification Is Evidence About The Final State

The Session Audit listed every `run_command` that reached a process as a verification command, in the order it ran. Ordering against the Session's file changes was never recorded, so a command that ran before an edit was reported exactly like one that ran after it — and because the list was non-empty, it suppressed the `verification_missing` risk that actually applied.

Session `sess_msb4s8jp` ran `npm test` and `npm run typecheck` in its second and third turns to survey the workspace, applied its only patch nine turns later, and never re-ran either. The audit reported both commands at exit 0 and `Remaining risks: none`, the model's summary presented them as verification of the change, and the plan item "Verify with typecheck/test" was closed having run nothing. The change was a README line, so nothing broke; the same audit shape over a code change is a false green.

So commands now carry the number of successful patches the Session had applied when they ran, and the audit compares it against the final count. A command that predates the last change is still reported — it ran, and hiding it would lose evidence — but marked `ranBeforeFinalChange`, rendered as "ran before the final change" everywhere the audit is presented, excluded from the Trace Corroboration behind a Memory Suggestion, and unable to suppress `verification_missing`.

Failures are read against the final state for the same reason. A red `npm test` before the fix and a green one after is the ordinary shape of repair work, not a risk the user has to carry; only a post-change failure raises `verification_failed`. The pre-change run stays visible in the listing, marked, so nothing is concealed by the narrower risk.
