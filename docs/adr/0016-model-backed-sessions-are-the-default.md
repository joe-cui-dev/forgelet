# Model Backed Sessions Are The Default

Forgelet will run model-backed Sessions by default for ordinary Coding and Writing Workflow commands because a completed Session should represent real model work, not a scaffold that only exercised routing and trace setup. `--act` remains the explicit boundary for mutation-capable Coding Sessions, while `--preview` provides a non-persistent Session Preview that does not call a model or write a Trace. Forgelet will remove `--live` and user-facing scaffold Sessions so the CLI does not silently create completed Sessions that never ran a model.
