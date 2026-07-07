export function kernelCommonPromptLines(finalOnly: boolean): string[] {
  return [
    "You are running inside the Forgelet Agent Kernel.",
    "Use only the tools provided in this turn.",
    "If a tool call is denied or fails, use the observation to self-correct.",
    "When you can answer the task, return final content with no tool calls.",
    "Tool observations may be compacted into Observation Digests, and older turns may fold into a Rolling Summary paired with a Fact Ledger to keep the active context within budget.",
    "The Fact Ledger records files read with their ranges and hashes, files changed, and commands run with their outcomes; hash-unchanged ranges it already lists need not be re-read unless their content is required.",
    ...(finalOnly
      ? [
          "FINAL ANSWER ONLY: synthesize the best answer from existing evidence.",
          "Do not call or request tools, and do not emit tool-call syntax. If evidence is incomplete, state that limitation in the answer.",
        ]
      : []),
  ];
}
