import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "@jest/globals";
import { runCodingSession } from "../../src/workflows/coding.js";
import { runLearningSession } from "../../src/workflows/learning.js";
import { runWritingSession } from "../../src/workflows/writing.js";

test("typed workflow entries can create deterministic Sessions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-entries-"));

  const coding = await runCodingSession({
    task: "inspect",
    contextFiles: [],
    workspaceRoot,
  });
  const writing = await runWritingSession({
    task: "draft",
    contextFiles: [],
    workspaceRoot,
  });
  const learning = await runLearningSession({
    task: "learn",
    contextFiles: [],
    workspaceRoot,
  });

  expect(coding.summary).toContain("Workflow: coding");
  expect(writing.summary).toContain("Workflow: writing");
  expect(learning.summary).toContain("Workflow: learning");
  expect(coding.summary).toContain(
    "Execution: deterministic test seam; model client was omitted.",
  );
  expect(coding.tracePath).toMatch(/\.forgelet\/sessions\/.*\.jsonl$/);
});

test("typed workflow entries reject workflow-specific fields at compile time", () => {
  const _typeChecks = () => {
    // @ts-expect-error creativeStyle belongs to Writing Sessions.
    void runCodingSession({ task: "x", contextFiles: [], workspaceRoot: ".", creativeStyle: "vivid" });
    // @ts-expect-error act belongs to Coding Sessions.
    void runLearningSession({ task: "x", contextFiles: [], workspaceRoot: ".", act: true });

    const writing = runWritingSession({
      task: "x",
      contextFiles: [],
      workspaceRoot: ".",
    });
    writing satisfies Promise<{ writingArtifact?: unknown }>;
    void writing;
  };
  void _typeChecks;
});
