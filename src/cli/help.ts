import { CREATIVE_STYLE_PRESET_LIST } from "../creativeStylePresets/index.js";

export function helpText(): string {
  return `Forgelet

Usage:
  forge code "<task>"
  forge code --debug "<task>"
  forge code --preview "<task>"
  forge code --preview --act "<task>"
  forge code --context issue.md "<task>"
  forge code --with-browser "<task>"
  forge code --allow-read README.md --allow-read src/workflows "<task>"
  forge code --write-scope src "<task>"
  forge code --write-scope src --write-scope docs --allow-command "npm test" "<task>"
  forge code --write-scope . --max-wall-clock-ms 1800000 --max-turns 20 "<task>"
  forge queue
  forge decide <sessionId>
  forge decide
  forge write --preview --context draft.md "revise this"
  forge write --context draft.md "revise this"
  forge write --with-browser "turn this article into an outline"
  forge write --creative --style vivid "write a rain-soaked convenience store scene"
  forge write --preview --creative --style vivid "write a rain-soaked convenience store scene"
  forge write --creative --style vivid --context scene.md "revise this scene"
  forge write --creative --style vivid --continue .forgelet/writing/chapter-1.md "continue the next chapter"
  forge write projects create my-novel
  forge write --project my-novel --creative --style vivid "write chapter one"
  forge write --project my-novel --creative --style vivid "continue from the project head"
  forge write --project my-novel --creative --style vivid --continue .forgelet/writing/chapter-1.md "revise chapter one"
  forge write artifacts list
  forge write artifacts show .forgelet/writing/chapter-1.md
  forge write artifacts show <sessionId> --full
  forge write artifacts search "rain scene"
  forge write artifacts search --limit 5 "chapter"
  forge learn --context paper.md "teach me the core ideas"
  forge learn --debug --context paper.md "teach me the core ideas"
  forge learn --with-browser "turn this article into study notes"
  forge learn --preview --context paper.md "teach me the core ideas"
  forge notes create --scope project --from-session <sessionId>
  forge notes create --scope project --from-session <sessionId> --title "Custom title"
  forge notes search --scope project "workflow graph design"
  forge notes search --scope project --limit 5 "workflow graph design"
  forge code --model deepseek-v4-pro "<task>"
  forge --version | -v
  forge code --budget 0.25 "<task>"
  forge config get
  forge config set <key> <value>
  forge config set activeContext.maxConversationBytes 65536
  forge config set activeContext.observationDigestPreviewBytes 2048
  forge config set activeContext.protectedRecentTurns 3
  forge sessions list
  forge sessions show <sessionId>
  forge resume <sessionId> "<instruction>"
  forge resume <sessionId> --debug "<instruction>"
  forge resume <sessionId> --act "<instruction>"
  forge debug show <sessionId>
  forge debug show <sessionId> --full
  forge browser read-current
  forge browser install-host --extension-id <chrome-extension-id>
  forge explain <sessionId>
  forge memory list [--all]
  forge memory suggest <sessionId>
  forge memory accept <suggestionId>

Use --preview to inspect the selected Workflow, route, budget, read scope, and capabilities without calling a model or creating a Session or Trace. Repeat --allow-read with workspace-relative file or directory paths to constrain workspace and Git reads for one Session. Add --with-browser to attach the current browser snapshot as read-only context. Add --act for coding runs that may request confirmed file edits and configured commands. Add --debug to model-backed Session commands to write a local Debug Transcript under .forgelet/debug/; it may contain full prompts, context, tool inputs, tool observations, and model output.

Writing runs return Critique, Revision, and Notes, and model-backed writing Sessions save the drafted or revised prose under .forgelet/writing/. Creative writing runs use a Creative Brief with optional context: prompt-only briefs return Draft only; context-backed revisions return Critique, Revision, Alternatives, and Notes. Use --continue with a Markdown Writing Artifact to produce a new Draft without overwriting the source. Use write projects create and --project <slug> to group artifacts in a manifest and continue from the project head. Use write artifacts list/show/search to inspect the project-local Writing Artifact Catalog without calling a model or creating a Session. Styles: ${CREATIVE_STYLE_PRESET_LIST}.
Learning runs require --context or --with-browser and return a source-linked Learning Pack with Summary, Key Concepts, Source Links, Open Questions, and Review Prompts. Learning Sessions record output and Trace evidence only; they do not write Knowledge Library notes during the Session.
Knowledge Notes promote completed, source-backed Learning Sessions into project Markdown notes under .forgelet/knowledge/. Use notes create --scope project --from-session <sessionId> to accept a Learning Pack, and notes search --scope project "<query>" for local Markdown search. Personal scope and JSON output are not available yet.
Session Continuation supports live Coding Workflow resume. Use plain resume for read-only continuation, or resume --act to request confirmed file edits and configured commands in the new child Session.
Repeat --write-scope with workspace-relative path prefixes (or "." for the whole workspace) to declare a coding run's Effect Envelope; this is the only switch into background semantics, so no separate flag is needed. Within the envelope, confirm-tier actions auto-approve and are cited in the Trace; the command allowlist defaults to every configured safe command unless narrowed with --allow-command. An action outside the envelope pauses the Session in place instead of prompting and exits; use forge queue to list paused Sessions and forge decide <sessionId> (or forge decide with exactly one paused Session) to approve, deny, approve-and-widen, or stop it. Use --max-wall-clock-ms and --max-turns to override the wall-clock and model-turn ceilings for one run.
Debug Transcripts are explicit local diagnostics. Use debug show for a structured preview, or debug show --full to expand the stored content.
V1 config set supports memoryFile, activeContext config keys, and provider API key env vars.`;
}
