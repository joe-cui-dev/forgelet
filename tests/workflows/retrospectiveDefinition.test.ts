import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRetrospectiveWorkflowDefinition,
  formatFrictionSignalsForPrompt,
  parseSuggestionLines,
  RETROSPECTIVE_NONE_SENTINEL,
} from "../../src/workflows/retrospective.js";
import { runRetrospectiveSession } from "../../src/workflows/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import type { FrictionSignal } from "../../src/memory/frictionSignal.js";

const FRICTION: FrictionSignal[] = [
  { kind: "tool_failure", toolName: "search_text", errorCode: "invalid_input", error: "ENOTDIR: not a directory" },
  { kind: "permission_friction", decision: "deny", toolName: "run_command", capability: "run_safe_command", reason: "not on safe list" },
];

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-retro-"));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# Agents\nRead history by globbing.\n", "utf8");
  await writeFile(join(workspaceRoot, "CONTEXT.md"), "# Context\nGlossary only.\n", "utf8");
  await writeFile(join(workspaceRoot, "README.md"), "# Forgelet\nCLI surface.\n", "utf8");
  await writeFile(join(workspaceRoot, "package.json"), `{"name":"scratch"}\n`, "utf8");
  return workspaceRoot;
}

test("the definition offers no tools and grants only read + text capabilities", () => {
  const definition = createRetrospectiveWorkflowDefinition({
    sourceSessionId: "sess_x",
    sourceTraceContent: "{}",
    frictionSignals: FRICTION,
  });

  expect(definition.kind).toBe("retrospective");
  expect(definition.capabilities({ act: false })).toEqual(["read_context", "model_generate_text"]);
  expect(definition.offersTools?.({ contextAttachments: [] })).toBe(false);
  const prompt = definition.systemPrompt({ act: false });
  expect(prompt).toContain("This is a Retrospective Workflow Session.");
  expect(prompt).toContain("You have no tools and cannot read the workspace");
});

test("parseSuggestionLines keeps only bullet lines and drops the NONE sentinel", () => {
  expect(
    parseSuggestionLines("Here are two:\n- First convention.\n* Second convention.\n\nDone."),
  ).toEqual(["First convention.", "Second convention."]);
  expect(parseSuggestionLines(`${RETROSPECTIVE_NONE_SENTINEL}`)).toEqual([]);
  expect(parseSuggestionLines(`- ${RETROSPECTIVE_NONE_SENTINEL}`)).toEqual([]);
});

test("formatFrictionSignalsForPrompt renders both signal kinds and is empty when none", () => {
  expect(formatFrictionSignalsForPrompt([])).toEqual([]);
  const lines = formatFrictionSignalsForPrompt(FRICTION).join("\n");
  expect(lines).toContain("Failed tool search_text [invalid_input]: ENOTDIR: not a directory");
  expect(lines).toContain("Permission deny for run_command (run_safe_command): not on safe list");
});

test("a Retrospective Session parses the model's bullets into suggestions", async () => {
  const workspaceRoot = await makeWorkspace();
  const model = new FakeModelClient([
    {
      content:
        "- In this workspace, search_text expects a directory; point it at a folder, not a file.\n- In this workspace, run commands only from the configured safe list.",
      toolCalls: [],
    },
  ]);

  const result = await runRetrospectiveSession({
    workspaceRoot,
    modelClient: model,
    sourceSessionId: "sess_friction",
    sourceTraceContent: `{"type":"tool_result","payload":{"ok":false}}\n`,
    frictionSignals: FRICTION,
  });

  expect(result.completion?.suggestions).toEqual([
    "In this workspace, search_text expects a directory; point it at a folder, not a file.",
    "In this workspace, run commands only from the configured safe list.",
  ]);

  // The single model turn saw the Friction Signals and the attached Trace.
  const firstTurn = model.turnInputs[0];
  const userMessage = firstTurn?.messages.find((message) => message.role === "user")?.content ?? "";
  expect(userMessage).toContain("Friction Signals found in this Session");
  expect(userMessage).toContain("Session Trace");
  expect(userMessage).toContain("AGENTS.md");
});

test("a Retrospective Session that finds nothing yields no suggestions", async () => {
  const workspaceRoot = await makeWorkspace();
  const model = new FakeModelClient([{ content: RETROSPECTIVE_NONE_SENTINEL, toolCalls: [] }]);

  const result = await runRetrospectiveSession({
    workspaceRoot,
    modelClient: model,
    sourceSessionId: "sess_quiet",
    sourceTraceContent: "{}\n",
    frictionSignals: FRICTION,
  });

  expect(result.completion?.suggestions).toEqual([]);
});
