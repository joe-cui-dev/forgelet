import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "../harness.js";
import { runAgent } from "../../src/agent/runAgent.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

test("a coding Session can search, read, and finish through read-only tools", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-readonly-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "export const answer = 'needle';\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_search", name: "search_text", input: { query: "needle" } },
      ],
    },
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.ts" } },
      ],
    },
    { content: "The answer is defined in example.ts.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "find the answer",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  assert.equal(result.session.stage, "final");
  assert.match(result.summary, /The answer is defined in example.ts/);
  assert.equal(modelClient.turnInputs.length, 3);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "session_started",
      "user_task",
      "routing_selected",
      "plan_update",
      "model_turn",
      "budget_update",
      "tool_call",
      "permission_decision",
      "tool_result",
      "model_turn",
      "budget_update",
      "tool_call",
      "permission_decision",
      "tool_result",
      "model_turn",
      "budget_update",
      "final_summary",
      "session_finished",
    ],
  );

  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  assert.ok(readResult);
  assert.equal(readResult.payload.ok, true);
  assert.equal(readResult.payload.path, "example.ts");
  assert.equal("content" in readResult.payload, false);
  assert.match(String(readResult.payload.preview), /needle/);
});

test("an ungranted tool call returns a denial observation and the Session can recover", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-deny-"));
  await writeFile(join(workspaceRoot, "draft.md"), "private draft\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "draft.md" } },
      ],
    },
    {
      content: "I cannot read workspace files in this workflow.",
      toolCalls: [],
    },
  ]);

  const result = await runAgent({
    workflow: "writing",
    task: "revise draft",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  assert.match(result.summary, /I cannot read workspace files/);
  assert.equal(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "read_file"),
    false,
  );
  assert.match(
    modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "",
    /permission_denied/,
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const denial = events.find(
    (event) =>
      event.type === "permission_decision" &&
      event.payload.toolName === "read_file",
  );
  assert.ok(denial);
  assert.equal(denial.payload.decision, "deny");
  const finished = events.find((event) => event.type === "session_finished");
  assert.equal(finished.payload.status, "completed");
});

test("a Session stops before the next model turn when the turn budget is exhausted", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-budget-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ budgets: { maxModelTurns: 1 } }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01 },
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
    { content: "This should not be called.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "inspect files",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  assert.equal(modelClient.turnInputs.length, 1);
  assert.match(result.summary, /Reason: max_model_turns/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const budgetUpdate = events.find((event) => event.type === "budget_update");
  assert.equal(budgetUpdate.payload.usage.modelTurns, 1);
  const finished = events.find((event) => event.type === "session_finished");
  assert.equal(finished.payload.status, "stopped");
  assert.equal(finished.payload.reason, "max_model_turns");
});

test("large read_file observations are truncated for the model and not stored fully in trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-truncate-"));
  const largeContent = `start\n${"x".repeat(25 * 1024)}\nneedle-at-end\n`;
  await writeFile(join(workspaceRoot, "large.txt"), largeContent, "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "large.txt" } },
      ],
    },
    { content: "The large file was truncated.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "read the large file",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  assert.equal(observation.metadata.truncated, true);
  assert.equal(
    observation.metadata.totalBytes,
    Buffer.byteLength(largeContent, "utf8"),
  );
  assert.equal(observation.content.length, 20 * 1024);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  assert.equal(readResult.payload.truncated, true);
  assert.equal(
    readResult.payload.totalBytes,
    Buffer.byteLength(largeContent, "utf8"),
  );
  assert.equal("content" in readResult.payload, false);
  assert.doesNotMatch(String(readResult.payload.preview), /needle-at-end/);
});

test("update_plan records the changed Session plan in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-plan-"));
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_plan",
          name: "update_plan",
          input: {
            items: [
              { step: "Inspect workspace", status: "completed" },
              { step: "Answer user", status: "in_progress" },
            ],
          },
        },
      ],
    },
    { content: "Plan updated and answer prepared.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "make a plan",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const planUpdates = events.filter((event) => event.type === "plan_update");
  assert.equal(planUpdates.length, 2);
  assert.deepEqual(planUpdates.at(-1)?.payload.plan.items, [
    { step: "Inspect workspace", status: "completed" },
    { step: "Answer user", status: "in_progress" },
  ]);
});

test("read-only tools do not follow workspace symlinks outside the workspace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-symlink-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "forgelet-outside-"));
  await writeFile(join(outsideRoot, "secret.txt"), "outside secret\n", "utf8");
  await symlink(
    join(outsideRoot, "secret.txt"),
    join(workspaceRoot, "secret-link.txt"),
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "secret-link.txt" },
        },
      ],
    },
    { content: "The file is outside the workspace.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "read symlink",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  assert.match(toolMessage, /outside workspace/);
  assert.doesNotMatch(toolMessage, /outside secret/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  assert.equal(readResult.payload.ok, false);
  assert.equal(readResult.payload.error.code, "invalid_input");
});
