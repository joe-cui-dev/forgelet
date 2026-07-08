import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import { runWritingSession } from "../../src/workflows/writing.js";

test("offers a tool-free wrap-up turn once input tokens cross the reserve threshold, stopping instead of completing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wrapup-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxInputTokens: 1000, maxModelTurns: 10 } }),
    "utf8",
  );

  const turns = [
    {
      usage: { inputTokens: 950, outputTokens: 5, estimatedCostUsd: 0.01 },
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
    {
      content: "Here is a summary of progress so far.",
      toolCalls: [],
    },
  ];
  let call = 0;
  const modelClient = {
    async createTurn() {
      return turns[call++];
    },
  };

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(call).toBe(2);
  expect(result.session.stage).toBe("final");
  expect(result.summary).toMatch(/Here is a summary of progress so far\./);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  const wrapupTriggered = events.find(
    (event) => event.type === "budget_wrapup_triggered",
  );
  expect(wrapupTriggered).toBeTruthy();
  expect(wrapupTriggered.payload).toMatchObject({
    turnIndex: 1,
    reason: "input_token_limit_exceeded",
    reserveFraction: 0.9,
  });
  expect(wrapupTriggered.payload.usage.inputTokens).toBe(950);

  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({
    status: "stopped",
    reason: "input_token_limit_exceeded",
  });
});

test("does not trigger onCompleted effects for a budget-stopped wrap-up", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wrapup-writing-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxInputTokens: 1000, maxModelTurns: 10 } }),
    "utf8",
  );

  const turns = [
    {
      usage: { inputTokens: 950, outputTokens: 5, estimatedCostUsd: 0.01 },
      content: "",
      toolCalls: [],
    },
    {
      content: "Draft\n\nA wrap-up scene.",
      toolCalls: [],
    },
  ];
  let call = 0;
  const modelClient = {
    async createTurn() {
      return turns[call++];
    },
  };

  const result = await runWritingSession({
    workflowVariant: "creative",
    creativeStyle: "vivid",
    task: "write a scene",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(call).toBe(2);
  expect(result.session.stage).toBe("final");
  expect(result.writingArtifact).toBeUndefined();
});
