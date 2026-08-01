import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import { runWritingSession } from "../../src/workflows/writing.js";

test("does not offer a wrap-up turn when input telemetry crosses the retired token limit", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wrapup-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 10 } }),
    "utf8",
  );

  const turns = [
    {
      usage: { inputTokens: 950, outputTokens: 5, estimatedCostUsd: 0.0095 },
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

  expect(events.some((event) => event.type === "budget_wrapup_triggered")).toBe(false);
  const budgetUpdates = events.filter((event) => event.type === "budget_update");
  expect(budgetUpdates).not.toHaveLength(0);
  expect(budgetUpdates[0].payload.limits).not.toHaveProperty("maxInputTokens");

  const finished = events.find((event) => event.type === "session_finished");
  expect(finished?.payload).toMatchObject({
    status: "completed",
  });
});

test("does not trigger onCompleted effects for a cost-budget-stopped wrap-up", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wrapup-writing-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 10, maxEstimatedCostUsd: 0.01 } }),
    "utf8",
  );

  const turns = [
    {
      usage: { inputTokens: 950, outputTokens: 5, estimatedCostUsd: 0.0095 },
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

test.each([
  ["model usage is missing", undefined],
  ["model cost is missing", { inputTokens: 20, outputTokens: 3 }],
])("marks an unpriced turn when %s", async (_label, firstUsage) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-unpriced-"));
  const turnInputs: { messages: { content: string }[] }[] = [];
  const turns = [
    {
      ...(firstUsage === undefined ? {} : { usage: firstUsage }),
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
    { content: "Done.", toolCalls: [] },
  ];
  let call = 0;
  const modelClient = {
    async createTurn(input: { messages: { content: string }[] }) {
      turnInputs.push(input);
      return turns[call++];
    },
  };

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(turnInputs).toHaveLength(2);
  // The ceiling itself is a calibrated default; what this pins is the "≥"
  // prefix and the unpriced count that go with it.
  expect(turnInputs[1]?.messages.at(-1)?.content).toMatch(
    /≥\$0\.0000\/\$\d+\.\d{4} \(1 turns unpriced\)/,
  );
  expect(turnInputs[1]?.messages.at(-1)?.content).toContain("0/30 min elapsed");
  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  expect(events.find((event) => event.type === "budget_update")?.payload.usage)
    .toMatchObject({ unpricedTurns: 1, estimatedCostUsd: 0 });
});

test("keeps the wrap-up answer when a provider ignores tool_choice none", async () => {
  // The wrap-up turn is sent with the tools attached and `tool_choice: "none"`.
  // A provider that asks for tools anyway must still have its calls refused,
  // but that must not also cost the Session the closing answer it wrote.
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-wrapup-ignored-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 2 } }),
    "utf8",
  );

  const turns = [
    { toolCalls: [{ id: "call_list", name: "list_files", input: {} }] },
    {
      content: "The final answer, written despite the stray tool call.",
      toolCalls: [{ id: "call_more", name: "list_files", input: {} }],
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

  expect(result.summary).toMatch(/The final answer, written despite/);
  expect(result.summary).toMatch(/Skipped 1 tool call because max_model_turns/);
  const events = (await readFile(result.tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  // The calls are still refused, not executed.
  expect(
    events.find((event) => event.type === "budget_blocked_tool_calls")?.payload,
  ).toMatchObject({ skippedCount: 1, reason: "max_model_turns" });
});

test("rejects an unknown DeepSeek model before a Session can spend", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-unpriced-model-"));
  const modelClient = { async createTurn() { return { content: "Done.", toolCalls: [] }; } };

  await expect(runCodingSession({
    task: "first run",
    contextFiles: [],
    workspaceRoot,
    model: "deepseek-uncatalogued",
    modelClient,
  })).rejects.toThrow(/Unknown DeepSeek model/);
});

test("stops on the known cost lower bound even after an unpriced turn", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-unpriced-cost-limit-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxEstimatedCostUsd: 0.01 } }),
    "utf8",
  );
  const turns = [
    { toolCalls: [{ id: "call_list", name: "list_files", input: {} }] },
    {
      usage: { inputTokens: 20, outputTokens: 3, estimatedCostUsd: 0.01 },
      toolCalls: [{ id: "call_again", name: "list_files", input: {} }],
    },
  ];
  let call = 0;
  const modelClient = { async createTurn() { return turns[call++]; } };

  const result = await runCodingSession({
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(call).toBe(2);
  expect(result.summary).toMatch(/Reason: estimated_cost_budget_exceeded/);
  expect(result.summary).toMatch(/Unpriced turns: 1/);
});
