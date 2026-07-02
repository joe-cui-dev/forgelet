export function helpText(): string {
  return `Forgelet

Usage:
  forge code "<task>"
  forge code --preview "<task>"
  forge code --preview --act "<task>"
  forge code --context issue.md "<task>"
  forge code --allow-read README.md --allow-read src/workflows "<task>"
  forge write --preview --context draft.md "revise this"
  forge write --context draft.md "revise this"
  forge write --creative --style vivid "write a rain-soaked convenience store scene"
  forge write --preview --creative --style vivid "write a rain-soaked convenience store scene"
  forge write --creative --style vivid --context scene.md "revise this scene"
  forge write --creative --style vivid --continue .forgelet/writing/chapter-1.md "continue the next chapter"
  forge code --model deepseek-v4-pro "<task>"
  forge --version | -v
  forge code --budget 0.25 "<task>"
  forge config get
  forge config set <key> <value>
  forge config set activeContext.maxObservationBytes 16384
  forge config set activeContext.observationDigestPreviewBytes 2048
  forge sessions list
  forge sessions show <sessionId>
  forge resume <sessionId> "<instruction>"
  forge resume <sessionId> --act "<instruction>"
  forge explain <sessionId>
  forge memory suggest <sessionId>
  forge memory accept <suggestionId>

Use --preview to inspect the selected Workflow, route, budget, read scope, and capabilities without calling a model or creating a Session or Trace. Repeat --allow-read with workspace-relative file or directory paths to constrain workspace and Git reads for one Session. Add --act for coding runs that may request confirmed file edits and configured commands.

Writing runs return Critique, Revision, and Notes, and model-backed writing Sessions save the drafted or revised prose under .forgelet/writing/. Creative writing runs use a Creative Brief with optional context: prompt-only briefs return Draft only; context-backed revisions return Critique, Revision, Alternatives, and Notes. Use --continue with a Markdown Writing Artifact to produce a new Draft without overwriting the source. Styles: vivid, tight, literary, plain.
Session Continuation supports live Coding Workflow resume. Use plain resume for read-only continuation, or resume --act to request confirmed file edits and configured commands in the new child Session.
V1 config set supports memoryFile, activeContext config keys, and provider API key env vars.`;
}
