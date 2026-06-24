import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
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
  expect(JSON.stringify(contextEvent.payload)).not.toMatch(
    /Hidden tail marker/,
  );
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

  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff"),
  ).toBe(true);
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
  expect(observation.content).toMatch(
    /\[truncated: showing 20480 of \d+ bytes\]/,
  );
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
  expect(JSON.stringify(diffResult.payload)).not.toMatch(
    /Hidden diff tail marker/,
  );
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
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-actionable-session-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const command = `${process.execPath} -e "console.log('verified')"`;
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ safeCommands: [command], commandTimeoutMs: 5_000 }),
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
    {
      toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }],
    },
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
  await expect(
    readFile(join(workspaceRoot, "example.txt"), "utf8"),
  ).resolves.toBe("changed\n");
  expect(result.summary).toMatch(/Changed example\.txt and verified/);
  expect(result.summary).toMatch(/Audit/);
  expect(result.summary).toMatch(/Forgelet changed: example\.txt/);
  expect(result.summary).toMatch(
    new RegExp(`Command: ${escapeRegExp(command)} \\(exit 0\\)`),
  );
  expect(result.summary).toMatch(/Trace:/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "workspace_baseline")).toBe(
    true,
  );
  expect(events.some((event) => event.type === "approval_decision")).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "tool_result" &&
        event.payload.toolName === "run_command",
    ),
  ).toBe(true);
  const finalSummary = events.find((event) => event.type === "final_summary");
  expect(finalSummary?.payload.audit).toEqual({
    changeGroups: {
      forgeletChanged: ["example.txt"],
      preExistingAtSessionStart: [],
      otherCurrentWorkspaceChanges: [],
    },
    verificationCommands: [{ command, exitCode: 0, timedOut: false }],
    kernelObservedRisks: [],
    modelTurns: 5,
    estimatedCostUsd: 0,
    tracePath: result.tracePath,
  });
});

test("an actionable coding Session prompts the model with action and approval boundaries", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-action-prompt-"));
  const modelClient = new FakeModelClient([
    { content: "I will use approved tools only.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "make a safe edit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
  });

  const systemPrompt = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "system",
  )?.content ?? "";

  expect(systemPrompt).toMatch(/apply_patch/);
  expect(systemPrompt).toMatch(/run_command/);
  expect(systemPrompt).toMatch(/permission and approval/);
  expect(systemPrompt).not.toMatch(/do not claim to write files or run commands/);
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
  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "git_diff"),
  ).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "").toMatch(
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
      event.payload.toolName === "git_diff",
  );
  expect(denial).toBeTruthy();
  expect(denial.payload.decision).toBe("deny");
  expect(denial.payload.reason).toBe("Capability not granted: git_read");
});

test("a writing Session returns the V1 Critique Revision Notes shape", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-shape-"));
  await writeFile(join(workspaceRoot, "draft.md"), "This draft is wordy.\n", "utf8");
  const modelClient = new FakeModelClient([
    { content: "Make it shorter.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "writing",
    task: "revise for clarity",
    contextFiles: ["draft.md"],
    workspaceRoot,
    modelClient,
  });

  const systemPrompt = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "system",
  )?.content ?? "";

  expect(systemPrompt).toMatch(/Critique, Revision, Notes/);
  expect(systemPrompt).toMatch(/do not request workspace, git, shell, patch, or command tools/);
  expect(result.summary).toMatch(/Critique\n/);
  expect(result.summary).toMatch(/Revision\nMake it shorter\./);
  expect(result.summary).toMatch(/Notes\n/);
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
  expect(
    modelClient.turnInputs[0]?.tools.some((tool) => tool.name === "read_file"),
  ).toBe(false);
  expect(modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "").toMatch(
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

test("a Session stopped by input token limit reports the precise stop reason and budget details", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-input-budget-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxModelTurns: 8,
        maxInputTokens: 100,
        maxEstimatedCostUsd: 0.25,
      },
    }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      usage: { inputTokens: 101, outputTokens: 7, estimatedCostUsd: 0.01 },
      content: "I need another turn.",
      toolCalls: [{ id: "call_list", name: "list_files", input: {} }],
    },
    { content: "This should not be called.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "inspect files within a tiny token limit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  expect(modelClient.turnInputs.length).toBe(1);
  expect(result.summary).toMatch(/Reason: input_token_limit_exceeded/);
  expect(result.summary).toMatch(/Model turns: 1\/8/);
  expect(result.summary).toMatch(/Input tokens: 101\/100/);
  expect(result.summary).toMatch(/Output tokens: 7/);
  expect(result.summary).toMatch(/Estimated cost: \$0\.0100\/\$0\.2500/);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const finished = events.find((event) => event.type === "session_finished");
  expect(finished.payload.status).toBe("stopped");
  expect(finished.payload.reason).toBe("input_token_limit_exceeded");
});

test("an over-budget actionable turn records budget-blocked tool calls without approval or execution", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-budget-block-tool-"),
  );
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      budgets: {
        maxModelTurns: 8,
        maxInputTokens: 100,
        maxEstimatedCostUsd: 0.25,
      },
    }),
    "utf8",
  );
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
      usage: { inputTokens: 101, outputTokens: 7, estimatedCostUsd: 0.01 },
      content: "I will patch this file.",
      toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }],
    },
    { content: "This should not be called.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "change example within a tiny token limit",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  expect(modelClient.turnInputs.length).toBe(1);
  await expect(
    readFile(join(workspaceRoot, "example.txt"), "utf8"),
  ).resolves.toBe("original\n");
  expect(result.summary).toMatch(/Reason: input_token_limit_exceeded/);
  expect(result.summary).toMatch(
    /Skipped 1 tool call because input_token_limit_exceeded was reached\./,
  );

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "tool_call")).toBe(false);
  expect(events.some((event) => event.type === "permission_decision")).toBe(
    false,
  );
  expect(events.some((event) => event.type === "approval_decision")).toBe(
    false,
  );
  const blocked = events.find(
    (event) => event.type === "budget_blocked_tool_calls",
  );
  expect(blocked?.payload).toEqual({
    reason: "input_token_limit_exceeded",
    skippedCount: 1,
    toolNames: ["apply_patch"],
  });
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
  expect(observation.metadata.totalBytes).toBe(
    Buffer.byteLength(largeContent, "utf8"),
  );
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
  expect(readResult.payload.totalBytes).toBe(
    Buffer.byteLength(largeContent, "utf8"),
  );
  expect("content" in readResult.payload).toBe(false);
  expect(String(readResult.payload.preview)).not.toMatch(/needle-at-end/);
});

test("read_file can continue from a byte offset without returning the first chunk again", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-byte-range-"));
  const content = `${"a".repeat(64)}SECOND_CHUNK${"b".repeat(64)}`;
  await writeFile(join(workspaceRoot, "range.txt"), content, "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "range.txt", offsetBytes: 64, limitBytes: 12 },
        },
      ],
    },
    { content: "Read the requested byte range.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "read a later byte range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("SECOND_CHUNK");
  expect(observation.metadata.rangeKind).toBe("byte");
  expect(observation.metadata.offsetBytes).toBe(64);
  expect(observation.metadata.limitBytes).toBe(12);
  expect(observation.metadata.returnedStartByte).toBe(64);
  expect(observation.metadata.returnedEndByte).toBe(76);
  expect(observation.metadata.nextOffsetBytes).toBe(76);

  const trace = await readFile(result.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readResult = events.find(
    (event) =>
      event.type === "tool_result" && event.payload.toolName === "read_file",
  );
  expect(readResult.payload.rangeKind).toBe("byte");
  expect(readResult.payload.returnedStartByte).toBe(64);
  expect(readResult.payload.returnedEndByte).toBe(76);
});

test("read_file can return a one-based line range without line number prefixes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-line-range-"));
  await writeFile(
    join(workspaceRoot, "lines.ts"),
    ["line one", "line two", "line three", "line four"].join("\n"),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "lines.ts", startLine: 2, lineCount: 2 },
        },
      ],
    },
    { content: "Read the requested line range.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "read a line range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("line two\nline three");
  expect(observation.content).not.toMatch(/^2:/);
  expect(observation.metadata.rangeKind).toBe("line");
  expect(observation.metadata.startLine).toBe(2);
  expect(observation.metadata.lineCount).toBe(2);
  expect(observation.metadata.returnedStartLine).toBe(2);
  expect(observation.metadata.returnedEndLine).toBe(3);
});

test("read_file tail reads return the end of a file instead of the first chunk", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-tail-range-"));
  await writeFile(
    join(workspaceRoot, "tail.txt"),
    ["first line", "middle line", "tail one", "tail two"].join("\n"),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "tail.txt", tailLines: 2 },
        },
      ],
    },
    { content: "Read the tail.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "read the file tail",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("tail one\ntail two");
  expect(observation.content).not.toMatch(/first line/);
  expect(observation.metadata.rangeKind).toBe("tail");
  expect(observation.metadata.tailLines).toBe(2);
  expect(observation.metadata.returnedStartLine).toBe(3);
  expect(observation.metadata.returnedEndLine).toBe(4);
});

test("read_file rejects conflicting range modes as invalid input", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-range-conflict-"));
  await writeFile(join(workspaceRoot, "conflict.txt"), "one\ntwo\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: {
            path: "conflict.txt",
            startLine: 1,
            lineCount: 1,
            tailLines: 1,
          },
        },
      ],
    },
    { content: "Saw the range conflict.", toolCalls: [] },
  ]);

  const result = await runAgent({
    workflow: "coding",
    task: "read conflicting ranges",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(false);
  expect(observation.error.code).toBe("invalid_input");
  expect(observation.error.message).toMatch(/range modes are mutually exclusive/i);

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

test("read_file byte ranges beyond the end return an empty successful observation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-range-eof-"));
  await writeFile(join(workspaceRoot, "short.txt"), "short", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "short.txt", offsetBytes: 100, limitBytes: 10 },
        },
      ],
    },
    { content: "Saw the empty range.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "read beyond eof",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(true);
  expect(observation.content).toBe("");
  expect(observation.metadata.rangeKind).toBe("byte");
  expect(observation.metadata.totalBytes).toBe(5);
  expect(observation.metadata.returnedBytes).toBe(0);
  expect(observation.metadata.returnedStartByte).toBe(5);
  expect(observation.metadata.returnedEndByte).toBe(5);
  expect(observation.metadata.nextOffsetBytes).toBeUndefined();
});

test("read_file rejects zero as a one-based start line", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-line-zero-"));
  await writeFile(join(workspaceRoot, "lines.txt"), "one\ntwo\n", "utf8");
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_read",
          name: "read_file",
          input: { path: "lines.txt", startLine: 0, lineCount: 1 },
        },
      ],
    },
    { content: "Saw the invalid line range.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "read invalid line range",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const toolMessage = modelClient.turnInputs[1]?.messages.at(-1)?.content ?? "";
  const observation = JSON.parse(toolMessage);
  expect(observation.ok).toBe(false);
  expect(observation.error.code).toBe("invalid_input");
  expect(observation.error.message).toMatch(/positive integer input: startLine/);
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

test("update_plan tells the model the required plan item shape", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-plan-schema-"));
  const modelClient = new FakeModelClient([
    { content: "No plan update needed.", toolCalls: [] },
  ]);

  await runAgent({
    workflow: "coding",
    task: "inspect the plan tool",
    contextFiles: [],
    workspaceRoot,
    modelClient,
  });

  const updatePlan = modelClient.turnInputs[0]?.tools.find(
    (tool) => tool.name === "update_plan",
  );
  expect(updatePlan?.inputSchema).toEqual({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            step: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["step", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  });
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
