import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  expect(result.session.stage).toBe("final");
  expect(result.summary).toMatch(/The answer is defined in example.ts/);
  expect(modelClient.turnInputs.length).toBe(3);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(events.map((event) => event.type)).toEqual([
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
    ]);

  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult).toBeTruthy();
  expect(readResult.payload.ok).toBe(true);
  expect(readResult.payload.path).toBe("example.ts");
  expect("content" in readResult.payload).toBe(false);
  expect(String(readResult.payload.preview)).toMatch(/needle/);
});

test("context attachments are rendered for the model without storing full content in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-context-"));
  const largeContext = `Important issue context\n${"x".repeat(22 * 1024)}\nHidden tail marker\n`;
  await writeFile(join(workspaceRoot, "issue.md"), largeContext, "utf8");
  const modelClient = new FakeModelClient([
    { content: "I can see the attached issue context.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "use the attached issue",
    contextFiles: ["issue.md"],
    workspaceRoot,
    modelClient,
  });

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "user",
  )?.content;
  expect(firstUserMessage).toBeTruthy();
  expect(firstUserMessage).toMatch(/Context attachments:/);
  expect(firstUserMessage).toMatch(/id: ctx_1/);
  expect(firstUserMessage).toMatch(/source: file/);
  expect(firstUserMessage).toMatch(/title: issue\.md/);
  expect(firstUserMessage).toMatch(/contentHash:/);
  expect(firstUserMessage).toMatch(/contentBytes:/);
  expect(firstUserMessage).toMatch(/returnedBytes: 20480/);
  expect(firstUserMessage).toMatch(/truncated: true/);
  expect(firstUserMessage).toMatch(/Important issue context/);
  expect(firstUserMessage).toMatch(/\[truncated: showing 20480 of \d+ bytes\]/);
  expect(firstUserMessage).not.toMatch(/Hidden tail marker/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const contextEvent = events.find(
    (event) => event.type === "context_attachment",
  );
  expect(contextEvent).toBeTruthy();
  expect("content" in contextEvent.payload).toBe(false);
  expect(JSON.stringify(contextEvent.payload)).not.toMatch(/Hidden tail marker/);
});

test("a coding Session can inspect a truncated git diff without storing the full diff in the trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-git-diff-"));
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "review.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "review.txt"]);
  const changedContent = `changed\n${"x".repeat(25 * 1024)}\nHidden diff tail marker\n`;
  await writeFile(join(workspaceRoot, "review.txt"), changedContent, "utf8");
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "I reviewed the diff.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "review the diff",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff")).toBe(true);
  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.toolName).toBe("git_diff");
  expect(observation.metadata.truncated).toBe(true);
  expect(observation.metadata.returnedBytes).toBe(20 * 1024);
  expect(observation.content).toMatch(/Git diff stat:/);
  expect(observation.content).toMatch(/review\.txt/);
  expect(observation.content).toMatch(/Git diff:/);
  expect(observation.content).toMatch(/changed/);
  expect(observation.content).toMatch(/\[truncated: showing 20480 of \d+ bytes\]/);
  expect(observation.content).not.toMatch(/Hidden diff tail marker/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const diffResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "git_diff",
  );
  expect(diffResult).toBeTruthy();
  expect("content" in diffResult.payload).toBe(false);
  expect(diffResult.payload.truncated).toBe(true);
  expect(JSON.stringify(diffResult.payload)).not.toMatch(/Hidden diff tail marker/);
});

test("a coding Session exposes only registry-projected tool schemas to the model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-tools-"));
  const modelClient = new FakeModelClient([
    { content: "Tools inspected.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "inspect available tools",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const tools = modelClient.turnInputs[0]?.tools ?? [];
  expect(tools.map((tool) => tool.name)).toEqual([
      "list_files",
      "search_text",
      "read_file",
      "git_status",
      "git_diff",
      "update_plan",
    ]);
  expect(tools.some((tool) => "execute" in tool)).toBe(false);
  expect(tools.some((tool) => "providerId" in tool)).toBe(false);
  expect(tools.some((tool) => "capability" in tool)).toBe(false);
});

test("an actionable coding Session can patch, run a configured command, inspect diff, and finish", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-actionable-session-"));
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const command = `${process.execPath} -e "console.log('verified')"`;
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ safeCommands: [command], commandTimeoutMs: 1_000 }),
    "utf8",
  );
  await execGit(workspaceRoot, ["add", ".forgelet/config.json"]);
  await execGit(workspaceRoot, ["commit", "-m", "configure safe commands"]);
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read", name: "read_file", input: { path: "example.txt" } },
      ],
    },
    { toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }] },
    {
      toolCalls: [
        { id: "call_command", name: "run_command", input: { command } },
      ],
    },
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "Changed example.txt and verified the result.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "change example",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  expect(modelClient.turnInputs[0]?.tools.map((tool) => tool.name)).toEqual([
    "list_files",
    "search_text",
    "read_file",
    "git_status",
    "git_diff",
    "update_plan",
    "apply_patch",
    "run_command",
  ]);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "changed\n",
  );
  expect(result.summary).toMatch(/Changed example\.txt and verified/);
  expect(result.summary).toMatch(/Audit/);
  expect(result.summary).toMatch(/Forgelet changed: example\.txt/);
  expect(result.summary).toMatch(new RegExp(`Command: ${escapeRegExp(command)} \\(exit 0\\)`));
  expect(result.summary).toMatch(/Trace:/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "workspace_baseline")).toBe(true);
  expect(events.some((event) => event.type === "approval_decision")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "tool_result" && event.payload.toolName === "run_command",
    ),
  ).toBe(true);
  const finalSummary = events.find((event) => event.type === "final_summary");
  expect(finalSummary?.payload.audit).toEqual({
    changeGroups: {
      forgeletChanged: ["example.txt"],
      preExistingAtSessionStart: [],
      otherCurrentWorkspaceChanges: [],
    },
    verificationCommands: [
      { command, exitCode: 0, timedOut: false },
    ],
    kernelObservedRisks: [],
    modelTurns: 5,
    estimatedCostUsd: 0,
    tracePath: result.tracePath,
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("a writing Session requesting git_diff receives a controlled registry denial", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-git-"));
  const modelClient = new FakeModelClient([
    { toolCalls: [{ id: "call_diff", name: "git_diff", input: {} }] },
    { content: "I cannot inspect git diffs in this workflow.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "writing",
    task: "review git diff",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(result.summary).toMatch(/cannot inspect git diffs/);
  expect(modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff")).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "").toMatch(/permission_denied/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const denial = events.find(
    (event) =>
      event.type === "permission_decision" &&
      event.payload.toolName === "git_diff",
  );
  expect(denial).toBeTruthy();
  expect(denial.payload.decision).toBe("deny");
  expect(denial.payload.reason).toBe("Capability not granted: git_read");
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

  expect(result.summary).toMatch(/I cannot read workspace files/);
  expect(modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "read_file")).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "").toMatch(/permission_denied/);

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
  expect(denial).toBeTruthy();
  expect(denial.payload.decision).toBe("deny");
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("completed");
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

  expect(modelClient.turnInputs.length).toBe(1);
  expect(result.summary).toMatch(/Reason: max_model_turns/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const budgetUpdate = events.find((event) => event.type === "budget_update");
  expect(budgetUpdate.payload.usage.modelTurns).toBe(1);
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("stopped");
  expect(finished.payload.reason).toBe("max_model_turns");
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
  expect(observation.metadata.truncated).toBe(true);
  expect(observation.metadata.totalBytes).toBe(Buffer.byteLength(largeContent, "utf8"));
  expect(observation.content.length).toBe(20 * 1024);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.truncated).toBe(true);
  expect(readResult.payload.totalBytes).toBe(Buffer.byteLength(largeContent, "utf8"));
  expect("content" in readResult.payload).toBe(false);
  expect(String(readResult.payload.preview)).not.toMatch(/needle-at-end/);
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
  expect(planUpdates.length).toBe(2);
  expect(planUpdates.at(-1)?.payload.plan.items).toEqual([
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
  expect(toolMessage).toMatch(/outside workspace/);
  expect(toolMessage).not.toMatch(/outside secret/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.ok).toBe(false);
  expect(readResult.payload.error.code).toBe("invalid_input");
});

function execGit(workspaceRoot: string, args: string[]): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        ...args,
      ],
      { cwd: workspaceRoot },
      (error) => {
      if (error) rejectExec(error);
      else resolveExec();
      },
    );
  });
}
