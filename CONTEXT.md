# Forgelet

Forgelet is a local-first personal agent platform. Its first surface is a CLI, and its reusable center is an Agent Kernel that can run multiple permissioned workflows.

## Language

**Agent Kernel**:
The reusable local engine that coordinates model turns, tools, permissions, budgets, traces, and workflow state. A Workflow uses the kernel; it is not the whole product.
_Avoid_: Coding agent, chatbot core

**Workflow**:
A named task shape that uses the Agent Kernel to coordinate stages, model calls, tools, permissions, trace, budget, and review.
_Avoid_: Prompt, mode, command

**ReAct Node**:
A bounded unit of model-and-tool interaction that the Agent Kernel runs for a Workflow, within which model turns, tool calls, permission checks, budget accounting, Active Context compaction, and Trace evidence occur. A Workflow runs one or more ReAct Nodes.
_Avoid_: Agent loop, chat loop, Session, workflow stage

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

**Learning Pack**:
The structured understanding a Learning Workflow Session delivers from explicitly attached source material: a summary, key concepts, source links, open questions, and review prompts in a fixed section shape. Its claims must be supported by the attached sources, its review prompts must be answerable from the pack itself, and its source links describe the Session's actual attachments rather than model output. The pack is the normalized final outcome; text observed while a Session is still running is live presentation, not the pack.
_Avoid_: Chat answer, summary blob, raw model output, notes file

**Page Brief**:
The lean structured outcome a Browser Workbench page-summarization Session delivers from the explicitly captured current page: a summary and key concepts in a fixed two-section shape, for fast page understanding rather than study. Its claims must be supported by the captured page content. A Page Brief is not a reduced Learning Pack: it never carries source links, open questions, or review prompts, and Learning Pack invariants do not apply to it. Like the pack, the brief is the normalized final outcome; streamed text is live presentation, not the brief.
_Avoid_: Learning Pack, trimmed pack, chat answer, highlight list

**Session**:
One auditable run of a Workflow, including the user's task, selected workflow, context, trace, decisions, and final outcome. A Session may pause awaiting a user decision and later continue as the same Session; the pause, the decision, and the continuation are Trace events, not new Sessions.
_Avoid_: Agent conversation, chat session, workflow session

**Session Continuation**:
A new Session that continues from a prior Session while preserving explicit lineage. It inherits Continuation Context but does not mutate earlier Sessions or their Traces.
_Avoid_: Reopened session, appended trace, chat resume

**Background Session**:
A Session whose Effect Envelope was declared at start. Declaring the envelope is what makes it background: in-envelope confirmable actions are auto-approved with Trace evidence, and an action beyond the envelope pauses the Session in place for the Decision Queue instead of prompting. It is not a separate mode, workflow, or process kind, and the process runs in the user's foreground terminal until it completes or pauses.
_Avoid_: Unattended mode, daemon session, async job, detached session

**Pause Snapshot**:
The resumable working state a paused Session writes at the moment it pauses — its model-facing conversation, Effect Envelope, remaining budget, and workflow position — so the same Session can resume in a later process. A Pause Snapshot is working state, not a record: it exists only while its Session is paused, and is deleted once the Session resumes past it or reaches a terminal outcome. It is neither Trace evidence nor a Debug Transcript.
_Avoid_: Debug Transcript, checkpoint chain, session backup, saved conversation

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
The single folded message at the head of a Session's conversation that replaces its oldest turns when Observation Digests alone cannot keep the conversation within budget. It pairs a task-anchored, model-generated narrative with a Fact Ledger, is rewritten in place each time more turns are folded, and both halves are deterministically bounded so the Rolling Summary alone can never exhaust the fold target. The narrative preserves the findings, conclusions, and open judgments still needed to complete the Session's task; it is not a recap of activity, and facts of record (what was read, changed, or run) belong to the Fact Ledger.
_Avoid_: Chat summary, progress report, checkpoint chain, durable memory, transcript

**Fact Ledger**:
The deterministic, machine-assembled part of a Rolling Summary that carries facts forward from folded Observation Digests, such as files read with their ranges and hashes, files changed, and commands run with their outcomes. A Fact Ledger never passes through a model and is deterministically bounded; evicted entries remain recoverable from the Trace.
_Avoid_: Model summary, durable memory, trace event, transaction log

**Turn Status**:
The volatile per-turn state the Agent Kernel reports to the model — plan progress, budget consumption, compaction status, and wrapup notices — kept distinct from the task context, which does not change from turn to turn. Turn Status is rendered after the conversation so the Active Context ahead of it stays stable across turns.
_Avoid_: Budget line, status prompt, system reminder

**Degraded Fold**:
A fold performed after repeated summarization failures, in which the Rolling Summary's narrative is a deterministic placeholder pointing at the Trace while the Fact Ledger updates as usual. A Degraded Fold is fully traced and is not a silent drop.
_Avoid_: Silent drop, truncation, retry

**Workspace Summary**:
A deterministic, on-demand overview of the current project workspace exposed through read Capabilities. It helps the model understand project shape without becoming Durable Memory or bypassing Session Read Scope.
_Avoid_: Repository cache, project memory, hidden index

**Anchor Files**:
The fixed set of high-signal files — package.json, README.md, AGENTS.md, and CONTEXT.md — located directly at a Workspace Summary's effective scan root, which the summary always detects and excerpts when readable, regardless of scan truncation. Anchor Files never bypass Session Read Scope; nested same-named files and lockfiles are not Anchor Files.
_Avoid_: Manifest, Project Manifest, priority files, special files

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

**Effect Envelope**:
The user-declared boundary of durable effects one Session may apply without per-action confirmation, stated when the Session starts and recorded as Trace evidence. The Permission Policy auto-approves confirmable actions inside the envelope; actions outside it require an explicit user decision, and destructive or secret-touching actions stay denied regardless of the envelope. A Decision Queue decision may widen a paused Session's envelope for the rest of that Session; the amendment is recorded as Trace evidence like the original declaration.
_Avoid_: Auto-approve flag, permission bypass, global trust setting, unattended mode

**Decision Queue**:
The cross-Workflow surface listing Sessions paused for a user decision, with enough Trace-backed context to decide. Deciding from the queue resumes the paused Session; the decision itself is recorded as a Trace event.
_Avoid_: Notification feed, inbox, approval log, review UI

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

**Memory Suggestion**:
A proposed Durable Memory entry with provenance to a source Session or Trace. It is not reusable guidance until the user accepts it.
_Avoid_: Durable Memory, automatic memory, extracted fact

**Project Memory Review**:
The deterministic user decision process for pending project-scope Memory Suggestions. It inspects provenance and records acceptance or rejection without starting a model-backed Workflow.
_Avoid_: Memory Review Workflow, model review, automatic memory approval

**Memory Decision**:
The recorded user decision that accepted or rejected one Memory Suggestion. A Memory Decision is self-contained evidence: it carries the suggestion's identity, its source Session, the outcome, when it was decided, a hash and short preview of the suggestion text that was judged, the Trace Corroboration observed at decision time, and — for an acceptance — the Rendered Memory Block it intends to write and its destination.
_Avoid_: Status flag, trace event, approval entry

**Memory Decision Log**:
The append-only project-scope record of Memory Decisions and Memory Write Records — the sole authority on whether a Memory Suggestion was decided and on whether an accepted suggestion's Rendered Memory Block was written. It is decision evidence in the spirit of a Trace but is not a Session Trace; suggestion status stored anywhere else is derived state.
_Avoid_: Session Trace, suggestions file, current-state store

**Rendered Memory Block**:
The deterministic Markdown block rendered from a Memory Suggestion alone — the exact bytes Project Memory Review previews and an acceptance writes into Durable Memory. Its identity is its bytes; file-boundary normalization applied at write time is not part of the block.
_Avoid_: Preview, template output, memory text, file content

**Memory Write Record**:
The recorded evidence in the Memory Decision Log that an accepted Memory Suggestion's Rendered Memory Block landed in Durable Memory, appended after the write completes or after a repair finds the block already present. It records what was actually written and where, which may honestly differ from what its Memory Decision intended.
_Avoid_: Write confirmation flag, ack, status update, trace event

**Memory Write Gap**:
The derived state of an accepted Memory Suggestion whose Memory Decision has no corresponding Memory Write Record. It is computed at read time from the Memory Decision Log alone, never stored and never inferred from the user-editable Durable Memory file, and re-running the acceptance closes it.
_Avoid_: Crash state, error flag, pending write, stored status

**Provenance Snapshot**:
The bounded source evidence written into a Memory Suggestion when it is proposed: the derivation inputs behind the suggestion text, a pointer to the source Trace with its hash and size at proposal time, and source Session metadata. It is written once, never rewritten, and lets Project Memory Review display and decide provenance without the source Trace being present.
_Avoid_: Trace copy, live audit, full session history, preview

**Trace Corroboration**:
The derived status of a Memory Suggestion's source Trace measured against its Provenance Snapshot: verified, differs, missing, or unreadable. It is computed at read time, never stored, and never blocks a Memory Decision; the one recorded exception is the corroboration observed at decision time inside the Memory Decision.
_Avoid_: Integrity gate, trace status flag, validation error, stored state

**Memory Scope**:
The layer a Durable Memory entry belongs to: project scope for guidance about one workspace, personal scope for cross-project preferences and habits. Scope determines where an entry lives and which Sessions may recall it.
_Avoid_: Folder, config file, global settings

**Memory Recall**:
The bounded selection of Durable Memory entries into a Session's Active Context, chosen by Memory Scope and task relevance within a budget instead of injecting whole memory files. What was recalled is recorded as Trace evidence.
_Avoid_: Memory dump, whole-file injection, RAG, hidden context

**Browser Context Bridge**:
The read-only browser integration where a user-approved extension sends page context into Forgelet as a browser Context Attachment.
_Avoid_: Browser automation, cookie access, hidden page scraping

**Browser Workbench**:
The read-only browser surface that turns an explicit browser action into a permissioned Forgelet Session and presents its live outcome. It is a Session caller, not a Workflow or browser automation runtime.
_Avoid_: Browser Workflow, browser agent, browser automation, Side Panel Workflow

**Page Conversation**:
A source-bound Browser Workbench conversation created from one explicit immutable page capture, identified independently from its launch attempts and Sessions, and projected in the Side Panel from a linear Session Continuation chain. Its first successful root Session delivers the Page Brief; follow-up turns use the original captured page, the conversation so far, and the model's own background knowledge, and never silently recapture, read the workspace, or query the public Web.
_Avoid_: Browser chat, live-page chat, general assistant conversation

**Page Conversation History**:
The ordered user questions and normalized final answers inherited by each new Session in a Page Conversation. Its complete record remains in ancestor Traces; each child Session may compact older turns inside its own Active Context, and streamed model text never enters the history.
_Avoid_: Transcript, Trace replay, streamed output, Continuation Context

**Page Conversation Head**:
The most recent successfully completed Session in a Page Conversation and the parent of its next follow-up. Running, stopped, and failed child Sessions never advance the head.
_Avoid_: Latest Session, active invocation, newest Trace, cursor

**Page Conversation Projection**:
The bounded, disposable Side Panel view of one Page Conversation stored per browser window for reattachment during the current browser session. It may contain normalized outcomes and attempt statuses but is never the authority for the capture, Session lineage, or continuation history.
_Avoid_: Conversation store, transcript, Session state, browser memory

**Page Answer**:
The normalized final outcome of one Page Conversation follow-up: an `Answer` that addresses the user's question — which may draw on the model's background knowledge beyond the captured page, with depth matched to the question — and either up to three Evidence excerpts mechanically verifiable against the original capture, or an explicit not-found grounding status meaning no passage in the captured page backs the Answer, not that the question went unanswered. An empty or unverifiable Evidence section is invalid unless it carries the exact not-found signal; streamed text is live presentation, not the Page Answer.
_Avoid_: Page Brief, chat message, raw model output, Learning Pack

**Workspace Profile**:
A user-approved binding between a non-CLI Forgelet surface and one local workspace, used to choose where a Session belongs without granting arbitrary workspace access.
_Avoid_: Recent workspace, cwd, path argument, project selector

**Public Web Query Scope**:
The Session authority that limits what information may shape queries sent to public Web providers. The default task-only scope admits the user's task and the sources the user explicitly attached when launching the Session, and excludes Browser Context; the task-and-browser-context scope may also expose Browser Context, after separate explicit approval. Attaching sources and granting public Web access in the same launch gesture is what makes those sources task-scope information.
_Avoid_: Web flag, prompt instruction, browser permission, context allowlist

**Session Source Ledger**:
The ordered, Session-owned collection of source material accepted into a Workflow, including initial Context Attachments and sources acquired during tool use. Each entry keeps stable source identity and provenance for Active Context, source-linked outputs, and Trace metadata.
_Avoid_: Tool observation history, Trace, source-links section

**Web Source**:
Public page content acquired by a successful bounded public Web read and accepted into the Session Source Ledger as extracted text. Its identity is its canonical URL and the hash of that text; a repeated read of the same content resolves to the existing entry. An HTML read whose extraction yields almost no text is not a successful read and produces no Web Source. A Web Source is one origin of Context Attachments, distinct from the search results that merely pointed to it.
_Avoid_: Search result, raw HTML, cached page, bookmark

**Search Candidate**:
A bounded preview — title, URL, snippet — returned by a public Web search. A Search Candidate is a lead, not a source: it carries no authority, never enters the Session Source Ledger, and only becomes a Web Source through a successful public Web read.
_Avoid_: Source, citation, result page
