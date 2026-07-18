import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type {
  Capability,
  ModelToolCall,
  ToolObservation,
} from "../../src/types.js";
import type { ToolRegistry } from "../../src/tools/toolRegistry.js";
import {
  executeParallelReadToolCalls,
  groupToolCallsForExecution,
} from "../../src/kernel/toolCallBatch.js";
import { runCodingSession } from "../../src/workflows/coding.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

function execGit(workspaceRoot: string, args: string[]): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
      { cwd: workspaceRoot },
      (error) => {
        if (error) rejectExec(error);
        else resolveExec();
      },
    );
  });
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("groups consecutive read-capability calls together and keeps other calls as their own serial group", () => {
  const capabilities: Record<string, Capability> = {
    read_file: "read_workspace",
    list_files: "read_workspace",
    git_diff: "git_read",
    apply_patch: "write_workspace",
    run_command: "run_safe_command",
  };
  const registry: ToolRegistry = {
    listTools: () => [],
    capabilityFor: (name: string) => capabilities[name],
    execute: () => {
      throw new Error("not used by this test");
    },
  };

  const toolCalls: ModelToolCall[] = [
    { id: "1", name: "read_file", input: {} },
    { id: "2", name: "list_files", input: {} },
    { id: "3", name: "apply_patch", input: {} },
    { id: "4", name: "git_diff", input: {} },
    { id: "5", name: "run_command", input: {} },
  ];

  const groups = groupToolCallsForExecution(toolCalls, registry);

  expect(groups).toEqual([
    { kind: "parallel_read", toolCalls: [toolCalls[0], toolCalls[1]] },
    { kind: "serial", toolCall: toolCalls[2] },
    { kind: "parallel_read", toolCalls: [toolCalls[3]] },
    { kind: "serial", toolCall: toolCalls[4] },
  ]);
});

const fakeRegistryWithDelays = (delaysMs: Record<string, number>): ToolRegistry => ({
  listTools: () => [],
  capabilityFor: () => "read_workspace" as Capability,
  async execute(toolCall) {
    await wait(delaysMs[toolCall.id] ?? 0);
    return {
      observation: {
        ok: true,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        summary: `ran ${toolCall.id}`,
        metadata: {},
      } satisfies ToolObservation,
      permissionDecision: { kind: "allow", riskTier: "low", reason: "ok" },
    };
  },
});

test("returns observations in original call order even when calls complete out of order", async () => {
  const toolCalls: ModelToolCall[] = [
    { id: "slow", name: "read_file", input: {} },
    { id: "fast", name: "read_file", input: {} },
  ];
  const registry = fakeRegistryWithDelays({ slow: 30, fast: 5 });
  const traceCalls: { type: string; payload: Record<string, unknown> }[] = [];

  const observations = await executeParallelReadToolCalls({
    toolCalls,
    toolRegistry: registry,
    session: { id: "sess_1", workflow: "coding" } as never,
    workspaceRoot: "/tmp/workspace",
    grantedCapabilities: ["read_workspace"],
    turnIndex: 0,
    appendTrace: async (type, payload) => {
      traceCalls.push({ type, payload });
    },
  });

  expect(observations.map((observation) => observation.toolCallId)).toEqual([
    "slow",
    "fast",
  ]);

  const toolCallOrder = traceCalls
    .filter((event) => event.type === "tool_call")
    .map((event) => event.payload.id);
  expect(toolCallOrder).toEqual(["slow", "fast"]);
  const resultOrder = traceCalls
    .filter((event) => event.type === "tool_result")
    .map((event) => event.payload.toolCallId);
  expect(resultOrder).toEqual(["slow", "fast"]);
});

test("a mixed turn keeps an actionable call serial and ordered around concurrent reads", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-mixed-turn-"));
  await execGit(workspaceRoot, ["init"]);
  await writeFile(join(workspaceRoot, "a.txt"), "a\n", "utf8");
  await writeFile(join(workspaceRoot, "b.txt"), "b\n", "utf8");
  await execGit(workspaceRoot, ["add", "a.txt", "b.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const command = `${process.execPath} -e "console.log('ran')"`;
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ safeCommands: [command], commandTimeoutMs: 5_000 }),
    "utf8",
  );

  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_read_a", name: "read_file", input: { path: "a.txt" } },
        { id: "call_read_b", name: "read_file", input: { path: "b.txt" } },
        { id: "call_command", name: "run_command", input: { command } },
      ],
    },
    { content: "Read both files and ran the command.", toolCalls: [] },
  ]);

  const result = await runCodingSession({
    task: "inspect and run",
    contextFiles: [],
    workspaceRoot,
    modelClient,
    act: true,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  expect(result.summary).toMatch(/Read both files and ran the command\./);

  const secondTurnMessages = modelClient.turnInputs[1]?.messages ?? [];
  const toolMessages = secondTurnMessages.filter(
    (message) => message.role === "tool",
  );
  expect(toolMessages.map((message) => message.toolCallId)).toEqual([
    "call_read_a",
    "call_read_b",
    "call_command",
  ]);
  const commandObservation = JSON.parse(toolMessages[2]?.content ?? "{}");
  expect(commandObservation.ok).toBe(true);
  expect(commandObservation.metadata.command).toBe(command);
});
