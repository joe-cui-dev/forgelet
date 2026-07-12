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

  const prompt = definition.systemPrompt({ act: false });

  expect(prompt).toContain("This is a source-backed Learning Workflow Session.");
  expect(prompt).toContain(
    "Produce a Learning Pack with these headings: Summary, Key Concepts, Source Links, Open Questions, Review Prompts.",
  );
  expect(prompt).toContain(
    "Do not request workspace, git, shell, patch, command, note-writing, or browser automation tools.",
  );
});

test("learning definition completion exposes a typed Learning Pack while preserving the existing Trace summary contract", async () => {
  const definition = createLearningWorkflowDefinition();
  const normalizedMarkdown = definition.normalizeFinalContent?.(
    "## Summary\nCore idea.\n\n## Open Questions\nWhy does it work?",
    { contextAttachments: [] },
  ) ?? "";

  const effects = await definition.onCompleted?.({
    workspaceRoot: "/tmp/unused",
    session: {
      id: "sess_test",
      workflow: "learning",
      task: "teach me the core ideas",
      taskHash: "abcdef00",
      stage: "final",
      plan: { items: [] },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    finalContent: normalizedMarkdown,
    contextAttachments: [],
    appendTrace: async () => {},
  });

  // Existing Trace/CLI contract: the full normalized markdown is still
  // attached to the final_summary Trace event under finalContent.
  expect(effects?.finalSummaryTraceExtras).toEqual({
    finalContent: normalizedMarkdown,
  });

  // New: the same content is also available as a typed Learning Pack.
  expect(effects?.completion).toEqual({
    summary: "Core idea.",
    keyConcepts: "No separate key concepts were provided by the model.",
    sourceLinks: "- No explicit source attachment was loaded.",
    openQuestions: "Why does it work?",
    reviewPrompts: "No review prompts were provided by the model.",
  });
});

test("learning definition source links surface when a browser attachment was captured", () => {
  const definition = createLearningWorkflowDefinition();

  const normalized = definition.normalizeFinalContent?.("## Summary\nCore idea.", {
    contextAttachments: [
      {
        attachment: {
          id: "ctx_1",
          source: "browser",
          title: "Example Docs",
          uri: "https://example.com/docs",
          mimeType: "text/plain",
          contentBytes: 36,
          contentHash: "a".repeat(64),
          preview: "# Example Docs Useful page content.",
          capturedAt: "2026-07-12T00:00:00.000Z",
          trustLevel: "external",
        },
        content: "# Example Docs\n\nUseful page content.",
      },
    ],
  });

  expect(normalized).toContain("- browser: Example Docs");
  expect(normalized).toContain("  capturedAt: 2026-07-12T00:00:00.000Z");
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
