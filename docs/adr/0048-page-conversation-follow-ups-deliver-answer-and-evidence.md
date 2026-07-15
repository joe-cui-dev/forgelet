# Page Conversation Follow-Ups Deliver Answer and Evidence

_Revised by [ADR 0055](0055-page-answers-may-draw-on-model-background-knowledge.md): the `Answer` may now draw on model background knowledge beyond the captured page; the two-section shape and Evidence's mechanical verification below are unchanged._

Each completed Page Conversation follow-up delivers a normalized Page Answer with two required sections: `Answer` and `Evidence`. The root Session still delivers its two-section Page Brief, while streamed follow-up text remains replaceable live presentation until the normalized Page Answer arrives. A fixed evidence-bearing outcome is intentionally less chat-like than free-form Markdown because source grounding should remain visible instead of becoming an implicit model claim.
