import { expect, test } from "@jest/globals";
import { createCodingWorkflowDefinition } from "../../src/workflows/coding.js";

test("coding definition grants read-only capabilities by default", () => {
  const definition = createCodingWorkflowDefinition();

  expect(definition.capabilities({ act: false })).toEqual([
    "read_context",
    "read_workspace",
    "git_read",
    "update_plan",
    "model_generate_text",
  ]);
});

test("coding definition adds write and command capabilities in act mode", () => {
  const definition = createCodingWorkflowDefinition();

  expect(definition.capabilities({ act: true })).toEqual([
    "read_context",
    "read_workspace",
    "git_read",
    "update_plan",
    "model_generate_text",
    "write_workspace",
    "run_safe_command",
  ]);
});

test("coding definition renders the read-only system prompt", () => {
  const definition = createCodingWorkflowDefinition();

  expect(definition.systemPrompt({ act: false })).toBe(
    [
      "You are running inside the Forgelet Agent Kernel.",
      "Use only the tools provided in this turn.",
      "If a tool call is denied or fails, use the observation to self-correct.",
      "When you can answer the task, return final content with no tool calls.",
      "Tool observations may be compacted into Observation Digests, and older turns may fold into a Rolling Summary paired with a Fact Ledger to keep the active context within budget.",
      "The Fact Ledger records files read with their ranges and hashes, files changed, and commands run with their outcomes; hash-unchanged ranges it already lists need not be re-read unless their content is required.",
      "This is a read-only Coding Workflow Session.",
      "Read-only tools may inspect workspace content; do not claim to write files or run commands.",
      "When you need an overview of an unfamiliar workspace, call workspace_summary first.",
      "Follow up with targeted search_text, read_file, git_status, or git_diff only when specific evidence is needed.",
      "workspace_summary is an on-demand tool result; do not assume it was automatically injected.",
      "When you need to locate specific code — a symbol, a function, or where a described behavior is implemented — and the file is not named or obvious, find it with search_text before opening files with read_file; if the user named the file or the path is obvious, read it directly.",
      "Do not speculatively open multiple files in parallel before their relevance is confirmed; once search or references confirm which files matter, you may read them in parallel.",
    ].join("\n"),
  );
});

test("coding definition renders the actionable system prompt", () => {
  const definition = createCodingWorkflowDefinition();

  const prompt = definition.systemPrompt({ act: true });

  expect(prompt).toContain("This is an actionable Coding Workflow Session.");
  expect(prompt).toContain(
    "Do not claim verification succeeded unless a run_command observation shows the command ran successfully.",
  );
});
