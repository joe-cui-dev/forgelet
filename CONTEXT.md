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

**Learning Workflow**:
A Forgelet workflow focused on turning source material into structured understanding, such as summaries, key concepts, open questions, review prompts, and source-linked learning outputs. A Learning Workflow uses **Context Attachments** or browser context as source material; it is not the same as a **Writing Workflow**, **Knowledge Library**, or **Durable Memory**.
_Avoid_: Writing variant, notes app, memory extraction

**Learning Pack**:
The default output shape of a **Learning Workflow**, containing structured understanding of source material for immediate reading and later review. A Learning Pack is Session output with source provenance; it is not a **Knowledge Library** note until the user explicitly saves it.
_Avoid_: Knowledge note, memory entry, article draft

**Source Provenance**:
The visible identity of source material used by a **Session**, including enough origin, trust, and integrity context for a user to understand where an output came from. Source Provenance supports review and later knowledge curation; it is not a promise of sentence-level citation.
_Avoid_: Full citation graph, hidden prompt source, unverified reference

**Critique and Revision**:
The default V1 output shape for a **Writing Workflow**: Forgelet explains the main writing issues, states the revision strategy, and returns a revised version. The critique and the revision are both part of the result.
_Avoid_: Final text only, writing chat reply

**Creative Writing Workflow**:
A **Writing Workflow** specialization for short-form prose polishing, rewriting, style variation, and creative drafting from a **Creative Brief** and optional **Context Attachments**. It should remain text-first and distinct from a full **Writing Project** until project continuity becomes necessary.
_Avoid_: Generic writing chat, document editor, long-form project state

**Creative Brief**:
The user's prompt-level creative intent for a **Creative Writing Workflow**, including subject, constraints, desired form, audience, or tone. A Creative Brief can stand alone for original drafting or accompany **Context Attachments** for revision.
_Avoid_: Prompt blob, hidden context, document draft

**Draft Pack**:
The default V2 output shape for original creative drafting or **Writing Artifact Continuation** when the user is asking for new prose rather than revision: Forgelet returns only one primary draft. A Draft Pack avoids pretending there is existing source text to critique or revise, and avoids extra variants or process notes when the user asked for creation or continuation.
_Avoid_: Critique with no source text, revision without a draft, variants by default, process notes by default

**Revision Pack**:
The default V2 output shape for creative rewriting with **Context Attachments**: Forgelet returns a critique, one primary revision, two creative alternatives, and notes about the editing choices. A Revision Pack keeps short-form creative work useful without requiring **Writing Project** continuity.
_Avoid_: Single polished answer, variant-only response, editor chat

**Writing Artifact**:
A human-facing prose result produced by a **Writing Workflow**, such as a draft or revision, that can be read, reused, or selected as source material for later writing work.
_Avoid_: Trace event, hidden memory, context file

**Writing Artifact Continuation**:
A new **Creative Writing Workflow** Session that uses a prior **Writing Artifact** as the source text for continuing prose. It produces a new writing result without reopening the prior **Session**, mutating its **Trace**, or becoming a full **Writing Project**.
_Avoid_: Session Continuation, appended trace, project continuity

**Writing Project**:
A long-form creative work boundary such as a novel, serialized essay, or chapter-based manuscript where continuity across characters, setting, outline, style, and prior chapters matters. A Writing Project can use **Context Attachments** and the **Knowledge Library**, but it is not the same as one **Session**.
_Avoid_: One-off rewrite, chat history, single context file

**Workflow**:
A named task shape that uses the **Agent Kernel** to coordinate stages, model calls, tools, permissions, trace, budget, and review. Workflows can be coding, writing, image work, learning, research, or other personal agent routines.
_Avoid_: Prompt, mode, command

**Workflow Variant**:
A named specialization inside a **Workflow** that changes prompt shape, output contract, or trace classification without becoming a separate workflow family. Creative writing is a variant of the **Writing Workflow**, not a new top-level Workflow.
_Avoid_: Workflow kind, mode hidden in task text

**Session**:
One auditable run of a **Workflow**, including the user's task, selected workflow, context, trace, decisions, and final outcome. In V1, a **Session** belongs to the current project workspace and is the reusable boundary for review, explanation, and memory provenance.
_Avoid_: Agent conversation, chat session, workflow session

**Session Continuation**:
A new **Session** that continues from a prior **Session** while preserving an explicit **Session Lineage**. A Session Continuation inherits **Continuation Context** but does not mutate earlier Sessions or their **Traces**.
_Avoid_: Reopened session, appended trace, chat resume

**Session Lineage**:
The ancestry path of **Sessions** connected by **Session Continuations** from a current Session back to its root. A Session can have multiple continuations, so the broader continuation graph may branch while each resumed Session inherits from its own lineage path.
_Avoid_: Chat history, overwritten session, linear-only memory

**Continuation Context**:
The compact **Active Context** reconstructed from a **Session Lineage** for a **Session Continuation**. It carries prior task state, relevant observations, decisions, and outcomes into a new run without becoming **Durable Memory**.
_Avoid_: Durable memory, full transcript replay, hidden chat history

**Trace**:
The chronological record of events that actually occurred during a **Session**. A **Trace** is evidence for review, explanation, and memory provenance; it should not contain simulated model turns, tool calls, or permission decisions that did not happen.
_Avoid_: Transcript, log dump, demo script

**Session Preview**:
A non-persistent view of how Forgelet would run a task, including the selected **Workflow**, routing, budget, read scope, and capability grants. A Session Preview is not a **Session** and must not write a **Trace**.
_Avoid_: Dry-run Session, scaffolded trace, fake Session

**Context Attachment**:
User-provided or user-approved material attached to a **Session** so a **Workflow** can use it as task context. A **Trace** should record attachment provenance, size, hash, and a short preview rather than silently turning the attachment into durable full-text storage.
_Avoid_: Prompt paste, hidden source, trace content

**Active Context**:
The current model-facing working set assembled for a **Session** turn, including task context, attachments, recent interaction, and tool observations. Active Context may be compacted without changing the **Trace**.
_Avoid_: Trace, durable memory, full session history

**Workspace Summary**:
A deterministic, on-demand overview of the current project workspace exposed to a **Session** through read **Capabilities**. A Workspace Summary combines structural signals with bounded high-signal excerpts so the model can understand the project shape without becoming **Durable Memory**, a **Knowledge Library** note, or an unrestricted bypass around **Session Read Scope**.
_Avoid_: Repository cache, project memory, hidden index

**Session Live View**:
The real-time user-facing view of a running **Session**, showing visible progress such as model turns, tool calls, permission checkpoints, command execution, budget updates, and final output. A Session Live View is presentation, not the **Trace** itself.
_Avoid_: Trace stream, fake progress, transcript

**Model Output Stream**:
The real-time text emitted by a model provider during a model turn. A Model Output Stream is narrower than a **Session Live View** because it does not represent tool execution, approval decisions, or other kernel events.
_Avoid_: Session progress, typing animation, trace event

**Observation Digest**:
A compact model-facing representation of an older tool observation in **Active Context**. It preserves enough deterministic evidence for the model to understand what was observed, while avoiding replay of the full original result.
_Avoid_: Thin summary, trace payload, semantic memory

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

**Browser Snapshot Producer**:
The user-triggered side of the **Browser Context Bridge** that creates a short-lived current-page snapshot for Forgelet to consume as browser context. It produces context only after an explicit user action; it is not a browser automation agent or background scraper.
_Avoid_: Production snapshot, browser automation, background capture

**Cost-Aware Model Routing**:
The Forgelet principle that model choice is part of the workflow decision, not a hidden provider detail. Forgelet prefers low-cost models by default and makes any capability upgrade explicit and traceable.
_Avoid_: Cheap model mode, fixed model choice

**Routing Policy**:
The explicit configuration that maps a **Workflow** and stage to a model role or model ID. In V1, routing is based on workflow and stage rather than automatic task classification.
_Avoid_: Smart model picker, hidden fallback

**Tool Provider**:
A source of related tools that share an operational boundary, such as workspace files, shell commands, browser context, writing surfaces, local image generation, Photoshop, or MCP. A **Tool Provider** declares **Capabilities** and classifies provider-specific tool risk before its tools are used by a **Workflow**.
_Avoid_: Plugin, tool category

**Capability**:
A permission-relevant action class declared by a **Tool Provider**, such as reading workspace files, writing workspace files, running local processes, editing images, or mutating an external application. Permissions should reason about capabilities before individual tool names.
_Avoid_: Tool name, command type

**Workflow Capability Grant**:
The set of **Capabilities** a **Workflow** may request by default. A grant is necessary but not sufficient: each tool call still passes through the permission policy.
_Avoid_: Global tool access, tool allowlist

**Permission Policy**:
The Session-time rule that decides whether a concrete tool call is allowed, requires confirmation, or is denied after **Workflow Capability Grants** and provider-classified risk tier are considered.
_Avoid_: Tool allowlist, global approval

**Session Read Scope**:
The optional per-**Session** boundary that narrows which workspace content its read **Capabilities** may expose. It constrains workspace exploration without restricting user-provided **Context Attachments** or replacing the **Workflow Capability Grant** or **Permission Policy**.
_Avoid_: Read-file allowlist, prompt-only scope, write scope

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

Dev: "Is `forge learn` just another writing command?"

Domain expert: "No. A Learning Workflow produces a Learning Pack from source material. It can later feed a Knowledge Library note, but it is not itself a note-writing command."

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

Dev: "If the Coding Workflow has workspace write capability, can it edit files whenever it wants?"

Domain expert: "No. The Workflow Capability Grant only makes the request eligible. The Permission Policy still decides whether each concrete tool call is allowed, requires confirmation, or is denied."

Dev: "If a Coding Session can read the workspace, can a narrow dogfood run inspect every file?"

Domain expert: "Not when it has a Session Read Scope. The read Capability remains granted, but the Session boundary limits which workspace content its reading tools may expose."

Dev: "Does that prevent me from attaching a file outside the Session Read Scope?"

Domain expert: "No. A Context Attachment is material you explicitly provide; the Session Read Scope limits the model's workspace exploration, not that attachment."

Dev: "Can a Workspace Summary describe files outside a narrow Session Read Scope?"

Domain expert: "No. It is produced through read Capabilities, so it must summarize only workspace material the Session is allowed to read."

Dev: "If the Trace only stores a preview, does the model also lose everything it read?"

Domain expert: "Not immediately. Full observations can enter Active Context, and older ones can become Observation Digests so the model keeps deterministic evidence without replaying every byte."

Dev: "Can we fix context growth by storing full file contents in the Trace?"

Domain expert: "No. The Trace remains evidence-first and metadata-first. Richer retention belongs in Active Context as an Observation Digest, not hidden durable storage."

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

Dev: "Does creative writing require an attached draft?"

Domain expert: "No. A Creative Brief can stand alone for original drafting, while Context Attachments provide source text or reference material when the user wants revision or transformation."
