import { expect, test } from "@jest/globals";
import { createLearningWorkflowDefinition } from "../../src/workflows/learning.js";

test("learning definition grants source-backed text capabilities", () => {
  const definition = createLearningWorkflowDefinition();

  expect(definition.capabilities({ act: false })).toEqual([
    "read_context",
    "update_plan",
    "model_generate_text",
  ]);
});

test("learning definition renders the Learning Workflow system prompt", () => {
  const definition = createLearningWorkflowDefinition();

  const prompt = definition.systemPrompt({ act: false, finalOnly: false });

  expect(prompt).toContain("This is a source-backed Learning Workflow Session.");
  expect(prompt).toContain(
    "Produce a Learning Pack with these headings: Summary, Key Concepts, Source Links, Open Questions, Review Prompts.",
  );
  expect(prompt).toContain(
    "Do not request workspace, git, shell, patch, command, note-writing, or browser automation tools.",
  );
});

test("learning definition normalizes unstructured content into a Learning Pack", () => {
  const definition = createLearningWorkflowDefinition();

  expect(definition.normalizeFinalContent?.("Core idea.", { contextAttachments: [] })).toBe(
    [
      "## Summary",
      "Core idea.",
      "",
      "## Key Concepts",
      "No separate key concepts were provided by the model.",
      "",
      "## Source Links",
      "- No explicit source attachment was loaded.",
      "",
      "## Open Questions",
      "No open questions were provided by the model.",
      "",
      "## Review Prompts",
      "No review prompts were provided by the model.",
    ].join("\n"),
  );
});
