import { expect, jest, test } from "@jest/globals";
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
  expect(turnInputs[1]?.messages.at(-1)?.content).toContain(
    "≥$0.0000/$1.0000 (1 turns unpriced)",
  );
  expect(turnInputs[1]?.messages.at(-1)?.content).toContain("0/30 min elapsed");
  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace.trim().split("\n").map((line) => JSON.parse(line));
  expect(events.find((event) => event.type === "budget_update")?.payload.usage)
    .toMatchObject({ unpricedTurns: 1, estimatedCostUsd: 0 });
});

test("warns once when a routed DeepSeek model has no static price", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-unpriced-model-"));
  const write = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
  const modelClient = { async createTurn() { return { content: "Done.", toolCalls: [] }; } };

  await runCodingSession({
    task: "first run",
    contextFiles: [],
    workspaceRoot,
    model: "deepseek-uncatalogued",
    modelClient,
  });
  await runCodingSession({
    task: "second run",
    contextFiles: [],
    workspaceRoot,
    model: "deepseek-uncatalogued",
    modelClient,
  });

  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(
    expect.stringMatching(/deepseek-uncatalogued.*cost may be incomplete/i),
  );
  write.mockRestore();
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
