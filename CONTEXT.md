# Forgelet

Forgelet is a local-first personal agent platform. Its first surface is a CLI, and its reusable center is an Agent Kernel that can run multiple permissioned workflows.

## Language

**Agent Kernel**:
The reusable local engine that coordinates model turns, tools, permissions, budgets, traces, and workflow state. A Workflow uses the kernel; it is not the whole product.
_Avoid_: Coding agent, chatbot core

**Workflow**:
A named task shape that uses the Agent Kernel to coordinate stages, model calls, tools, permissions, trace, budget, and review.
_Avoid_: Prompt, mode, command

**Coding Workflow**:
The Forgelet workflow for repository tasks such as searching code, editing files, running tests, and explaining changes.
_Avoid_: The Forgelet product, generic agent loop

**Writing Workflow**:
The Forgelet workflow for drafting, revising, critiquing, or restructuring prose from user-provided or user-approved text context.
_Avoid_: Chat mode, document editor

**Style Preset**:
A named writing preference selected for Creative Writing that expands into a stable set of prose-shaping instructions, such as pacing, texture, tone, sentence shape, and revision pressure. A Style Preset names the desired prose effect, not the subject matter, genre, or a specific author's style.
_Avoid_: Style word, prompt adjective, freeform vibe, genre, author imitation

**Learning Workflow**:
The Forgelet workflow for turning source material into structured understanding, such as summaries, key concepts, open questions, review prompts, and source-linked learning outputs.
_Avoid_: Writing variant, notes app, memory extraction

**Session**:
One auditable run of a Workflow, including the user's task, selected workflow, context, trace, decisions, and final outcome.
_Avoid_: Agent conversation, chat session, workflow session

**Session Continuation**:
A new Session that continues from a prior Session while preserving explicit lineage. It inherits Continuation Context but does not mutate earlier Sessions or their Traces.
_Avoid_: Reopened session, appended trace, chat resume

**Trace**:
The chronological record of events that actually occurred during a Session. A Trace is evidence for review, explanation, and memory provenance.
_Avoid_: Transcript, log dump, demo script

**Debug Transcript**:
An explicit opt-in local record of the full agent-model exchange for a Session, including model-facing messages, available tools, model responses, tool calls, and tool observations. A Debug Transcript is for diagnosis and replay, while the Trace remains the audit evidence boundary.
_Avoid_: Trace, live view, permanent memory, hidden log

**Context Attachment**:
User-provided or user-approved material attached to a Session so a Workflow can use it as task context. Trace records attachment provenance, size, hash, and preview metadata.
_Avoid_: Prompt paste, hidden source, trace content

**Active Context**:
The current model-facing working set assembled for a Session turn, including task context, attachments, recent interaction, and tool observations. Active Context may be compacted without changing the Trace.
_Avoid_: Trace, durable memory, full session history

**Observation Digest**:
The deterministic compacted form of a tool observation in Active Context. A digest preserves source identity, range, content hash, truncation state, and a bounded excerpt of what was actually returned, without passing through a model.
_Avoid_: Model summary, truncated log, preview

**Rolling Summary**:
The single folded message at the head of a Session's conversation that replaces its oldest turns when Observation Digests alone cannot keep the conversation within budget. It pairs a model-generated narrative of the folded work with a Fact Ledger, is rewritten in place each time more turns are folded, and both halves are deterministically bounded so the Rolling Summary alone can never exhaust the fold target.
_Avoid_: Chat summary, checkpoint chain, durable memory, transcript

**Fact Ledger**:
The deterministic, machine-assembled part of a Rolling Summary that carries facts forward from folded Observation Digests, such as files read with their ranges and hashes, files changed, and commands run with their outcomes. A Fact Ledger never passes through a model and is deterministically bounded; evicted entries remain recoverable from the Trace.
_Avoid_: Model summary, durable memory, trace event, transaction log

**Degraded Fold**:
A fold performed after repeated summarization failures, in which the Rolling Summary's narrative is a deterministic placeholder pointing at the Trace while the Fact Ledger updates as usual. A Degraded Fold is fully traced and is not a silent drop.
_Avoid_: Silent drop, truncation, retry

**Workspace Summary**:
A deterministic, on-demand overview of the current project workspace exposed through read Capabilities. It helps the model understand project shape without becoming Durable Memory or bypassing Session Read Scope.
_Avoid_: Repository cache, project memory, hidden index

**Tool Provider**:
A source of related tools that share an operational boundary, such as workspace files, shell commands, browser context, writing surfaces, or MCP.
_Avoid_: Plugin, tool category

**Capability**:
A permission-relevant action class declared by a Tool Provider, such as reading workspace files, writing workspace files, running local processes, or mutating an external application.
_Avoid_: Tool name, command type

**Workflow Capability Grant**:
The set of Capabilities a Workflow may request by default. A grant is necessary but not sufficient: each tool call still passes through the Permission Policy.
_Avoid_: Global tool access, tool allowlist

**Permission Policy**:
The Session-time rule that decides whether a concrete tool call is allowed, requires confirmation, or is denied after Workflow Capability Grants and provider-classified risk are considered.
_Avoid_: Tool allowlist, global approval

**Session Read Scope**:
The optional per-Session boundary that narrows which workspace content read Capabilities may expose.
_Avoid_: Read-file allowlist, prompt-only scope, write scope

**Writing Artifact**:
A human-facing prose result produced by a Writing Workflow, such as a draft or revision, that can be read, reused, cataloged, or selected as source material for later writing work.
_Avoid_: Trace event, hidden memory, context file

**Writing Project**:
A named long-form writing effort, identified by a slug, that groups Writing Artifacts so later Writing Sessions can continue the work. Membership is declared in the Project Manifest, not inferred from Traces; Traces record the project slug as evidence only.
_Avoid_: Folder, tag, document, session group

**Project Manifest**:
The user-readable file that is the source of truth for a Writing Project: its identity, its ordered member Writing Artifacts, and its Continuation Head. A manifest groups existing artifacts; it does not store prose content.
_Avoid_: Document editor state, trace index, cache

**Continuation Head**:
The member Writing Artifact a Writing Project continues from by default. New members always join the member list, but the head advances deterministically only when a Session's continuation source was the current head; revising an earlier member never moves it. Users may edit the head in the Project Manifest.
_Avoid_: Latest file, newest artifact, cursor

**Knowledge Library**:
User-approved Markdown notes stored in a Knowledge Scope. The Knowledge Library stores source-linked articles, outlines, summaries, and learning notes for humans to read and reuse.
_Avoid_: Memory file, vector database, terminal-only output

**Durable Memory**:
User-approved project or personal guidance that Forgelet may reuse in later Sessions. Durable Memory must be inspectable, editable, and traceable to its source.
_Avoid_: Vector cache, session trace

**Browser Context Bridge**:
The read-only browser integration where a user-approved extension sends page context into Forgelet as a browser Context Attachment.
_Avoid_: Browser automation, cookie access, hidden page scraping
