# Workflow and Stage Based Model Routing

Forgelet V1 will route models by Workflow and stage rather than by hidden automatic task classification. This gives the project a real cost-aware routing policy while keeping decisions explainable: coding action can default to a low-cost capable model, writing critique can use a cheaper model, and review or fallback stages can explicitly escalate. More dynamic model selection can be added later after traces show where static routing is insufficient.
