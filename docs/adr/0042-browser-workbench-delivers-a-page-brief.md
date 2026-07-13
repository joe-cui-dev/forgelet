# Browser Workbench Delivers a Page Brief

Browser Workbench delivers a Page Brief: a source-backed `Summary` and `Key Concepts` for quick page understanding. `forge learn` continues to deliver the five-section Learning Pack, whose study-oriented invariants remain unchanged. Both flows remain Learning Workflow Sessions (`kind: "learning"`) and use the shared Learning Session Launcher; the workflow definition is parameterized by deliverable shape.

We rejected trimming the Learning Pack globally because it would weaken the CLI contract, adding a workflow kind because this is still source-backed learning, and hiding sections only in the panel because unused sections would still consume model tokens.
