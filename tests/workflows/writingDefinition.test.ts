import { expect, test } from "@jest/globals";
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
