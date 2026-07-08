import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_CREATIVE_STYLE_PRESETS_PATH } from "../../src/creativeStylePresets/index.js";
import { kernelCommonPromptLines } from "../../src/kernel/messages.js";
import { createWritingWorkflowDefinition } from "../../src/workflows/writing.js";

test("writing definition grants model text capabilities without project scope", () => {
  const definition = createWritingWorkflowDefinition({});

  expect(definition.capabilities({ act: false })).toEqual([
    "read_context",
    "update_plan",
    "model_generate_text",
  ]);
});

test("writing definition can read workspace for a scoped project", () => {
  const definition = createWritingWorkflowDefinition({ hasScopedProject: true });

  expect(definition.capabilities({ act: false, readScope: ["chapter.md"] })).toEqual([
    "read_context",
    "read_workspace",
    "update_plan",
    "model_generate_text",
  ]);
});

test("creative draft writing does not offer tools", () => {
  const definition = createWritingWorkflowDefinition({
    workflowVariant: "creative",
    creativeInputKind: "draft",
  });

  expect(
    definition.offersTools?.({
      contextAttachments: [],
    }),
  ).toBe(false);
});

test("creative revision writing can offer tools for provided context", () => {
  const definition = createWritingWorkflowDefinition({
    workflowVariant: "creative",
    creativeInputKind: "revision",
  });

  expect(
    definition.offersTools?.({
      contextAttachments: [],
    }),
  ).toBe(true);
});

test("writing definition wraps plain writing output into a Revision Pack", () => {
  const definition = createWritingWorkflowDefinition({});

  expect(definition.normalizeFinalContent?.("Tighter prose.", { contextAttachments: [] })).toBe(
    [
      "Critique",
      "No separate critique was provided by the model.",
      "",
      "Revision",
      "Tighter prose.",
      "",
      "Notes",
      "No additional notes were provided.",
    ].join("\n"),
  );
});

test("creative draft output is wrapped in a Draft heading", () => {
  const definition = createWritingWorkflowDefinition({
    workflowVariant: "creative",
    creativeInputKind: "draft",
  });

  expect(definition.normalizeFinalContent?.("Rain on glass.", { contextAttachments: [] })).toBe(
    ["Draft", "Rain on glass."].join("\n"),
  );
});

test("writing definition renders the plain writing system prompt", () => {
  const definition = createWritingWorkflowDefinition({});

  expect(definition.systemPrompt({ act: false })).toBe(
    [
      ...kernelCommonPromptLines(),
      "This is a Writing Workflow Session.",
      "Use the provided context and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
      "Return the final answer with these headings: Critique, Revision, Notes.",
    ].join("\n"),
  );
});

test("writing definition renders creative draft, continuation, and revision prompts", async () => {
  const workspaceRoot = await createWorkspaceWithLocalStylePreset();
  const stylePresetBlock = [
    "Style Preset: vivid",
    "Label: Private vivid label.",
    "Aim: Private vivid aim.",
    "Instructions:",
    "- Private instruction one.",
    "- Private instruction two.",
    "- Private instruction three.",
    "Avoid:",
    "- Private avoid one.",
    "- Private avoid two.",
    "Revision focus:",
    "- Private revision focus one.",
    "- Private revision focus two.",
  ].join("\n");

  const draft = createWritingWorkflowDefinition({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "draft",
  });
  await draft.prepareSession?.({ workspaceRoot });
  expect(draft.systemPrompt({ act: false })).toBe(
    [
      ...kernelCommonPromptLines(),
      "This is a Creative Writing Workflow variant.",
      stylePresetBlock,
      "Use the Creative Brief and Durable Memory for original drafting, but do not request workspace, git, shell, patch, or command tools.",
      "Return only a Draft heading followed by the drafted prose.",
    ].join("\n"),
  );

  const continuation = createWritingWorkflowDefinition({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
  });
  await continuation.prepareSession?.({ workspaceRoot });
  expect(continuation.systemPrompt({ act: false })).toBe(
    [
      ...kernelCommonPromptLines(),
      "This is a Creative Writing Workflow variant.",
      stylePresetBlock,
      "Use the Creative Brief, Continuation source, Additional context attachments, and Durable Memory to continue the source prose, but do not request workspace, git, shell, patch, or command tools.",
      "Return only a Draft heading followed by the continued prose.",
    ].join("\n"),
  );

  const revision = createWritingWorkflowDefinition({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "revision",
  });
  await revision.prepareSession?.({ workspaceRoot });
  expect(revision.systemPrompt({ act: false })).toBe(
    [
      ...kernelCommonPromptLines(),
      "This is a Creative Writing Workflow variant.",
      stylePresetBlock,
      "Use the Creative Brief, any provided Context Attachments, and Durable Memory, but do not request workspace, git, shell, patch, or command tools.",
      "If the brief asks for revision but no source text is attached or included, state that limitation and produce the best original draft or useful next step from the brief.",
      "Return a Revision Pack with these headings: Critique, Revision, Alternatives, Notes.",
      "Alternatives must include exactly two options: one more vivid/literary and one clearer/tighter.",
    ].join("\n"),
  );
});

async function createWorkspaceWithLocalStylePreset(): Promise<string> {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-writing-definition-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify(
      {
        vivid: {
          label: "Private vivid label.",
          aim: "Private vivid aim.",
          instructions: [
            "Private instruction one.",
            "Private instruction two.",
            "Private instruction three.",
          ],
          avoid: ["Private avoid one.", "Private avoid two."],
          revisionFocus: [
            "Private revision focus one.",
            "Private revision focus two.",
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return workspaceRoot;
}
