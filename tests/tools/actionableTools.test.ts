import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createActionableCodingTools } from "../../src/tools/actionable.js";
import { createToolRegistry } from "../../src/tools/toolRegistry.js";
import type { ToolContext } from "../../src/types.js";

const TEST_COMMAND_TIMEOUT_MS = 5_000;

test("run_command tells the model which exact commands are configured safe", () => {
  const tools = createActionableCodingTools({
    safeCommands: ["npm test", "npm run typecheck"],
    commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
    maxPatchBytes: 100_000,
    sessionState: {
      baselineDirtyPaths: new Set(),
      forgeletTouchedPaths: new Set(),
    },
  });

  const runCommand = tools.find((tool) => tool.name === "run_command");
  expect(runCommand?.description).toMatch(/npm test/);
  expect(runCommand?.description).toMatch(/npm run typecheck/);
  expect(runCommand?.description).toMatch(/exactly/);
});

test("apply_patch modifies an ordinary workspace file after approval", async () => {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const registry = createToolRegistry(
    createActionableCodingTools({
      safeCommands: [],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler: async () => ({
        status: "approved",
        reason: "Approved by test.",
        fullPatchShown: false,
      }),
    },
  );

  const result = await registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch } },
    testContext(workspaceRoot, ["write_workspace"]),
  );

  expect(result.permissionDecision.kind).toBe("confirm");
  expect(result.approvalDecision?.status).toBe("approved");
  expect(result.observation.ok).toBe(true);
  expect(result.observation.summary).toMatch(/Applied patch/);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "changed\n",
  );
});

test("apply_patch accepts git-apply compatible unified diff without diff headers", async () => {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  const patch = [
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const registry = createToolRegistry(
    createActionableCodingTools({
      safeCommands: [],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler: async () => ({
        status: "approved",
        reason: "Approved by test.",
      }),
    },
  );

  const result = await registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch } },
    testContext(workspaceRoot, ["write_workspace"]),
  );

  expect(result.observation.ok).toBe(true);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "changed\n",
  );
});

test("run_command executes an exact configured command after approval", async () => {
  const workspaceRoot = await createGitWorkspace();
  const command = `${process.execPath} -e "console.log('verified')"`;
  const registry = createToolRegistry(
    createActionableCodingTools({
      safeCommands: [command],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler: async () => ({
        status: "approved",
        reason: "Approved by test.",
      }),
    },
  );

  const result = await registry.execute(
    { id: "call_command", name: "run_command", input: { command } },
    testContext(workspaceRoot, ["run_safe_command"]),
  );

  expect(result.permissionDecision.kind).toBe("confirm");
  expect(result.approvalDecision?.status).toBe("approved");
  expect(result.observation.ok).toBe(true);
  expect(result.observation.summary).toMatch(/Command exited 0/);
  expect(result.observation.content).toMatch(/verified/);
});

test("run_command denies commands that do not exactly match safeCommands", async () => {
  const workspaceRoot = await createGitWorkspace();
  const configured = `${process.execPath} -e "console.log('verified')"`;
  const requested = `${configured} --extra`;
  const registry = createToolRegistry(
    createActionableCodingTools({
      safeCommands: [configured],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler: async () => {
        throw new Error("Unsafe commands should not request approval.");
      },
    },
  );

  const result = await registry.execute(
    { id: "call_command", name: "run_command", input: { command: requested } },
    testContext(workspaceRoot, ["run_safe_command"]),
  );

  expect(result.permissionDecision.kind).toBe("deny");
  expect(result.observation.ok).toBe(false);
  expect(result.observation.summary).toMatch(/unsafe/);
});

test("apply_patch denies targets that were dirty at Session start before approval", async () => {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-original",
    "+changed",
    "",
  ].join("\n");
  const registry = createToolRegistry(
    createActionableCodingTools({
      safeCommands: [],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
      sessionState: {
        baselineDirtyPaths: new Set(["example.txt"]),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler: async () => {
        throw new Error("Baseline-dirty targets should not request approval.");
      },
    },
  );

  const result = await registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch } },
    testContext(workspaceRoot, ["write_workspace"]),
  );

  expect(result.permissionDecision.kind).toBe("deny");
  expect(result.observation.summary).toMatch(/dirty at Session start/);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "original\n",
  );
});

test("apply_patch denies delete-file patches before approval", async () => {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(join(workspaceRoot, "example.txt"), "original\n", "utf8");
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "deleted file mode 100644",
    "--- a/example.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-original",
    "",
  ].join("\n");
  const registry = createToolRegistry(
    createActionableCodingTools({
      safeCommands: [],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler: async () => {
        throw new Error("Delete patches should not request approval.");
      },
    },
  );

  const result = await registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch } },
    testContext(workspaceRoot, ["write_workspace"]),
  );

  expect(result.permissionDecision.kind).toBe("deny");
  expect(result.observation.summary).toMatch(/delete-file patches are denied/i);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "original\n",
  );
});

function testContext(
  workspaceRoot: string,
  grantedCapabilities: ToolContext["grantedCapabilities"],
): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    workflow: "coding",
    grantedCapabilities,
  };
}

async function createGitWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-actionable-"));
  await execGit(workspaceRoot, ["init"]);
  return workspaceRoot;
}

function execGit(workspaceRoot: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
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
        if (error) reject(error);
        else resolve();
      },
    );
  });
}
