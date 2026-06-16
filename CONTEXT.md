# Forgelet

Forgelet is a local-first personal agent platform context. Its first usable workflow is coding, but its language should leave room for writing, research, image work, and other permissioned personal workflows.

## Language

**Agent Kernel**:
The reusable local engine that coordinates model turns, tools, permissions, budgets, traces, and workflow state. A **Workflow** uses the kernel; it is not itself the whole product.
_Avoid_: Coding agent, chatbot core

**Coding Workflow**:
The first Forgelet workflow, focused on small repository tasks such as searching code, editing files, running tests, and explaining changes. It proves the **Agent Kernel** without defining the full product boundary.
_Avoid_: The Forgelet product, generic agent loop

**Writing Workflow**:
The second Forgelet workflow shape, focused on drafting, revising, critiquing, or restructuring prose from user-provided text context. In V1 it exists to validate that the **Agent Kernel** is not coding-specific.
_Avoid_: Chat mode, document editor

**Critique and Revision**:
The default V1 output shape for a **Writing Workflow**: Forgelet explains the main writing issues, states the revision strategy, and returns a revised version. The critique and the revision are both part of the result.
_Avoid_: Final text only, writing chat reply

**Workflow**:
A named task shape that uses the **Agent Kernel** to coordinate stages, model calls, tools, permissions, trace, budget, and review. Workflows can be coding, writing, image work, learning, research, or other personal agent routines.
_Avoid_: Prompt, mode, command

**Workflow Graph**:
The explicit stage structure of a **Workflow**. A graph can include deterministic steps and local **ReAct Nodes** where exploration or tool use is needed.
_Avoid_: Single generic loop, hidden prompt flow

**ReAct Node**:
A bounded part of a **Workflow Graph** where the model can reason, call tools, observe results, and continue until the node's exit condition is met. A ReAct node is not the whole Forgelet execution model.
_Avoid_: Agent loop, autonomous session

**Personal Agent Platform**:
The long-term product shape where Forgelet can run multiple local-first, permissioned workflows across code, documents, browser context, writing, images, and personal knowledge.
_Avoid_: Coding-only CLI, generic assistant

**Writing and Knowledge Workbench**:
The V2 product focus that extends Forgelet from coding into article drafting, source-linked notes, learning summaries, and curated knowledge workflows. It builds on the **Writing Workflow**, browser read-only context, and user-approved memory.
_Avoid_: Generic notes app, chat writing assistant

**Knowledge Library**:
User-approved Markdown notes stored in a **Knowledge Scope**. The Knowledge Library stores source-linked articles, outlines, summaries, and learning notes for humans to read and reuse; it is not the same as **Durable Memory**.
_Avoid_: Memory file, vector database, terminal-only output

**Knowledge Scope**:
The ownership boundary for a **Knowledge Library**. Project knowledge lives under `.forgelet/knowledge/`; personal knowledge lives under `~/.forgelet/knowledge/`; V2 implements project scope first while preserving the same Markdown model for personal scope later.
_Avoid_: Single notes folder, hidden global knowledge

**Local Creative Tool Workflow**:
A later workflow family for local image and media tools such as Stable Diffusion or Photoshop. These workflows require explicit asset, process, and external-application capabilities before they become first-class.
_Avoid_: Image toy, unrestricted app automation

**Local Review UI**:
The V2 local web surface for inspecting and reviewing sessions, traces, plans, costs, memory suggestions, and knowledge notes. It observes the **Agent Kernel** first; workflow execution and external mutation remain CLI- and permission-led until later.
_Avoid_: Web app product, autonomous control panel

**Browser Context Bridge**:
The V2 read-only browser integration where a user-approved extension sends the current page URL, title, selected text, extracted page text, and optional screenshot metadata into Forgelet as a browser context attachment.
_Avoid_: Browser automation, cookie access, hidden page scraping

**Cost-Aware Model Routing**:
The Forgelet principle that model choice is part of the workflow decision, not a hidden provider detail. Forgelet prefers low-cost models by default and makes any capability upgrade explicit and traceable.
_Avoid_: Cheap model mode, fixed model choice

**Routing Policy**:
The explicit configuration that maps a **Workflow** and stage to a model role or model ID. In V1, routing is based on workflow and stage rather than automatic task classification.
_Avoid_: Smart model picker, hidden fallback

**Tool Provider**:
A source of related tools that share an operational boundary, such as workspace files, shell commands, browser context, writing surfaces, local image generation, Photoshop, or MCP. A **Tool Provider** declares **Capabilities** before its tools are used by a **Workflow**.
_Avoid_: Plugin, tool category

**Capability**:
A permission-relevant action class declared by a **Tool Provider**, such as reading workspace files, writing workspace files, running local processes, editing images, or mutating an external application. Permissions should reason about capabilities before individual tool names.
_Avoid_: Tool name, command type

**Workflow Capability Grant**:
The set of **Capabilities** a **Workflow** may request by default. A grant is necessary but not sufficient: each tool call still passes through the permission policy.
_Avoid_: Global tool access, tool allowlist

**Risk Tiered Autonomy**:
The default execution policy where low-risk read, analysis, and reversible model work can proceed automatically, durable writes or external effects require confirmation, and destructive or secret-touching actions are denied or strongly confirmed.
_Avoid_: Always plan-first, fully autonomous mode

**Memory Suggestion**:
A proposed durable memory entry derived from a trace, explanation, or workflow result. It is not durable memory until the user accepts it.
_Avoid_: Automatic memory write, hidden learning

**Durable Memory**:
User-approved project or personal knowledge that Forgelet may reuse in later sessions. Durable memory must be inspectable, editable, and traceable to its source.
_Avoid_: Vector cache, session trace

## Example Dialogue

Dev: "Is Forgelet a coding agent?"

Domain expert: "Coding is the first workflow. Forgelet itself is the local Agent Kernel plus the workflows and tools that run through it."

Dev: "So adding article drafting later should not replace the coding design?"

Domain expert: "Right. Article drafting becomes another Workflow using the same kernel boundaries: tools, permissions, trace, budget, and review."

Dev: "Should image editing be the next big area after coding?"

Domain expert: "Not before writing and knowledge workflows. V2 should prove source-linked writing and learning first; local creative tools can become V3 workflows once asset and external-app permissions are clear."

Dev: "Should a paper summary go into memory?"

Domain expert: "No. It should become a Knowledge Library note if the user accepts it. Durable Memory is reserved for reusable agent guidance, not full learning artifacts."

Dev: "Should a note about this repo and a personal essay outline live together?"

Domain expert: "No. They use the same Markdown note model, but different Knowledge Scopes: project notes stay in `.forgelet/knowledge/`, while personal notes belong in `~/.forgelet/knowledge/`."

Dev: "Should Forgelet become a web app?"

Domain expert: "Not as the primary product surface in V2. V2 can add a Local Review UI for inspecting traces, memory suggestions, and knowledge notes, while the CLI remains the first-class execution surface."

Dev: "How should Forgelet read the page I am viewing?"

Domain expert: "Through a Browser Context Bridge: a read-only extension where the user intentionally shares page context. MCP and browser automation can be later providers."

Dev: "Should Forgelet always use DeepSeek?"

Domain expert: "No. Forgelet should be cost-aware by default: start with a low-cost model when suitable, then explain any upgrade to a stronger or more expensive model."

Dev: "Should Forgelet infer the best model from any task text?"

Domain expert: "Not in V1. The Routing Policy should choose by Workflow and stage, with explicit fallback and escalation rules."

Dev: "Can Photoshop editing just be another tool?"

Domain expert: "It should come from a Tool Provider that declares image-editing and external-app mutation capabilities. The Workflow can call the tool only through those permissioned boundaries."

Dev: "Can the writing workflow run shell commands if it asks nicely?"

Domain expert: "No. The Writing Workflow does not receive shell or workspace mutation grants by default, so those tool calls should be denied before command-level risk is considered."

Dev: "Should Forgelet ask before every step?"

Domain expert: "No. Risk Tiered Autonomy lets safe reads and analysis proceed, asks before durable writes or external effects, and blocks destructive or secret-touching actions."

Dev: "Can Forgelet save what it learned from a run?"

Domain expert: "It can create a Memory Suggestion. It becomes Durable Memory only after the user accepts it."

Dev: "Is every task just the same ReAct loop?"

Domain expert: "No. Each task type should have a Workflow Graph. ReAct is useful inside graph nodes where Forgelet needs to explore or choose tools."

Dev: "Why include writing in V1 if coding is the first real use case?"

Domain expert: "Coding proves useful local action. Writing proves the kernel can support a non-code Workflow without changing its boundaries."

Dev: "Should writing just return the polished paragraph?"

Domain expert: "Not by default. V1 should return Critique and Revision so the user can see both the editing judgment and the proposed text."
