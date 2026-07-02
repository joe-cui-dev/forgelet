# Explicit Workflow Commands

Forgelet will require explicit Workflow commands for model-backed runs: Coding runs use `forge code ...`, Writing runs use `forge write ...`, and unknown top-level input fails instead of becoming a Coding task. This removes the convenient bare `forge "<task>"` shorthand because model-backed execution makes typo tolerance expensive and surprising: commands such as `forge session list` must not silently call a model.
