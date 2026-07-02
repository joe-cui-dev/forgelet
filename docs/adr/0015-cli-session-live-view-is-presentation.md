# CLI Session Live View Is Presentation

Forgelet will add a CLI Session Live View before the later local review UI or provider-level Model Output Stream so long-running model-backed Sessions are visible while they run. The live view is a presentation surface derived from real Agent Kernel activity; it must not turn spinner text, waiting states, or token deltas into Trace evidence.

The workflow runner should expose structured live events to callers rather than requiring the CLI to tail Trace files or treating `appendTrace` as the only presentation hook. Interactive progress, approval prompts, and patch previews render to stderr, while stdout remains reserved for the final Session summary so terminal use improves without breaking script-friendly output.

When an interactive `forge write` run has already streamed the final answer through the terminal live view, the CLI entrypoint suppresses replaying the full final summary on stdout and prints only compact handles such as the writing artifact path and Trace path. Non-interactive runs, redirected stdout, and the programmatic `runCli` result continue to expose the complete final summary.
