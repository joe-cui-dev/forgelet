export function helpText(): string {
  return `Forgelet

Usage:
  forge "<task>"
  forge --context issue.md "<task>"
  forge --allow-read README.md --allow-read src/workflows "<task>"
  forge write --context draft.md "revise this"
  forge write --creative --style vivid "write a rain-soaked convenience store scene"
  forge write --creative --style vivid --context scene.md "revise this scene"
  forge --live --budget 0.25 "<task>"
  forge --live --act "<task>"
  forge --model deepseek-v4-pro "<task>"
  forge --version | -v
  forge --budget 0.25 "<task>"
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

Forgelet V1 runs scaffolded Sessions by default. Use --live to run a real DeepSeek-backed Session. Repeat --allow-read with workspace-relative file or directory paths to constrain workspace and Git reads for one Session. Add --act for coding runs that may request confirmed file edits and configured commands.

Writing runs return Critique, Revision, and Notes. Creative writing runs use a Creative Brief with optional context: prompt-only briefs return Draft, Variants, and Notes; context-backed revisions return Critique, Revision, Alternatives, and Notes. Styles: vivid, tight, literary, plain.
Session Continuation supports live Coding Workflow resume. Use plain resume for read-only continuation, or resume --act to request confirmed file edits and configured commands in the new child Session.
V1 config set supports memoryFile, activeContext config keys, and provider API key env vars.`;
}
