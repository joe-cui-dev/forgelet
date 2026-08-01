import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createActionableCodingTools } from "../../src/tools/actionable.js";
import {
  createToolRegistry,
  type ApprovalHandler,
} from "../../src/tools/toolRegistry.js";
import type { ToolContext } from "../../src/types.js";

const TEST_COMMAND_TIMEOUT_MS = 5_000;

test("run_command tells the model which exact commands are configured safe", () => {
  const tools = createActionableCodingTools({
    settings: {
      safeCommands: ["npm test", "npm run typecheck"],
      commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
      maxPatchBytes: 100_000,
    },
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
      settings: {
        safeCommands: [],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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
      settings: {
        safeCommands: [],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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

test("apply_patch accepts new-file diffs without a trailing newline", async () => {
  const workspaceRoot = await createGitWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "new file mode 100644",
    "index 0000000..7e4a5c3",
    "--- /dev/null",
    "+++ b/example.txt",
    "@@ -0,0 +1,2 @@",
    "+first",
    "+second",
  ].join("\n");
  const registry = createToolRegistry(
    createActionableCodingTools({
      settings: {
        safeCommands: [],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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
    "first\nsecond\n",
  );
});

test("run_command executes an exact configured command after approval", async () => {
  const workspaceRoot = await createGitWorkspace();
  const command = `${process.execPath} -e "console.log('verified')"`;
  const registry = createToolRegistry(
    createActionableCodingTools({
      settings: {
        safeCommands: [command],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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
      settings: {
        safeCommands: [configured],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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
      settings: {
        safeCommands: [],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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
      settings: {
        safeCommands: [],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
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

test("apply_patch recounts hunk headers whose line counts disagree with the body", async () => {
  const workspaceRoot = await createPatchWorkspace();
  // Both headers overcount by one, the shape that made plain `git apply`
  // report `corrupt patch` and abandon a whole Session to retries.
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1,4 +1,5 @@",
    " line A",
    " line B",
    "+line B2",
    " line C",
    "@@ -4,3 +5,3 @@",
    "-old sentence",
    "+new sentence",
    " line E",
    "",
  ].join("\n");

  const result = await executePatch(workspaceRoot, patch);

  expect(result.observation.ok).toBe(true);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "line A\nline B\nline B2\nline C\nnew sentence\nline E\n",
  );
});

test("apply_patch applies a zero-context hunk anchored by a removed line", async () => {
  const workspaceRoot = await createPatchWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -4,1 +4,1 @@",
    "-old sentence",
    "+new sentence",
    "",
  ].join("\n");

  const result = await executePatch(workspaceRoot, patch);

  expect(result.observation.ok).toBe(true);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "line A\nline B\nline C\nnew sentence\nline E\n",
  );
});

test("apply_patch places a zero-context hunk by its removed line, not its header line number", async () => {
  const workspaceRoot = await createPatchWorkspace();
  // The header says line 2; the removed text really lives at line 4. The
  // removed line is what decides, so the edit still lands correctly.
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -2,1 +2,1 @@",
    "-old sentence",
    "+new sentence",
    "",
  ].join("\n");

  const result = await executePatch(workspaceRoot, patch);

  expect(result.observation.ok).toBe(true);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "line A\nline B\nline C\nnew sentence\nline E\n",
  );
});

test("apply_patch rejects an insert-only hunk that has no context to anchor it", async () => {
  const workspaceRoot = await createPatchWorkspace();
  // Nothing here can be matched against the file, so the line number in the
  // header would decide placement unchecked.
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1,0 +2,1 @@",
    "+inserted",
    "",
  ].join("\n");

  const result = await executePatch(workspaceRoot, patch);

  expect(result.observation.ok).toBe(false);
  expect(result.observation.summary).toMatch(/insert-only hunk/i);
  expect(result.observation.error?.message).toMatch(/context line/i);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "line A\nline B\nline C\nold sentence\nline E\n",
  );
});

test("apply_patch failure tells the model that miscounted headers are not the cause", async () => {
  const workspaceRoot = await createPatchWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -4,1 +4,1 @@",
    "-a sentence that is not in the file",
    "+new sentence",
    "",
  ].join("\n");

  const result = await executePatch(workspaceRoot, patch);

  expect(result.observation.ok).toBe(false);
  expect(result.observation.error?.message).toMatch(/recounted automatically/i);
  expect(result.observation.error?.message).toMatch(/read_file/);
});

test("apply_patch does not ask for approval for a patch that cannot apply", async () => {
  const workspaceRoot = await createPatchWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -4,1 +4,1 @@",
    "-a sentence that is not in the file",
    "+new sentence",
    "",
  ].join("\n");
  let approvalRequests = 0;

  const result = await executePatch(workspaceRoot, patch, async () => {
    approvalRequests += 1;
    return { status: "approved", reason: "Approved by test." };
  });

  expect(approvalRequests).toBe(0);
  expect(result.approvalDecision).toBeUndefined();
  // Still a confirm-tier request: it was never a permission problem.
  expect(result.permissionDecision.kind).toBe("confirm");
  expect(result.observation.ok).toBe(false);
  expect(result.observation.error?.code).toBe("tool_failed");
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "line A\nline B\nline C\nold sentence\nline E\n",
  );
});

test("apply_patch does not ask for approval for an insert-only hunk", async () => {
  const workspaceRoot = await createPatchWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1,0 +2,1 @@",
    "+inserted",
    "",
  ].join("\n");
  let approvalRequests = 0;

  const result = await executePatch(workspaceRoot, patch, async () => {
    approvalRequests += 1;
    return { status: "approved", reason: "Approved by test." };
  });

  expect(approvalRequests).toBe(0);
  expect(result.observation.summary).toMatch(/insert-only hunk/i);
});

test("apply_patch still asks for approval for a patch that applies", async () => {
  const workspaceRoot = await createPatchWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -4,1 +4,1 @@",
    "-old sentence",
    "+new sentence",
    "",
  ].join("\n");
  let approvalRequests = 0;

  const result = await executePatch(workspaceRoot, patch, async () => {
    approvalRequests += 1;
    return { status: "approved", reason: "Approved by test." };
  });

  expect(approvalRequests).toBe(1);
  expect(result.approvalDecision?.status).toBe("approved");
  expect(result.observation.ok).toBe(true);
});

test("apply_patch preflight leaves the workspace untouched when approval is rejected", async () => {
  const workspaceRoot = await createPatchWorkspace();
  const patch = [
    "diff --git a/example.txt b/example.txt",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -4,1 +4,1 @@",
    "-old sentence",
    "+new sentence",
    "",
  ].join("\n");

  const result = await executePatch(workspaceRoot, patch, async () => ({
    status: "rejected",
    reason: "Rejected by test.",
  }));

  expect(result.observation.ok).toBe(false);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "line A\nline B\nline C\nold sentence\nline E\n",
  );
});

async function createPatchWorkspace(): Promise<string> {
  const workspaceRoot = await createGitWorkspace();
  await writeFile(
    join(workspaceRoot, "example.txt"),
    "line A\nline B\nline C\nold sentence\nline E\n",
    "utf8",
  );
  await execGit(workspaceRoot, ["add", "example.txt"]);
  await execGit(workspaceRoot, ["commit", "-m", "baseline"]);
  return workspaceRoot;
}

function executePatch(
  workspaceRoot: string,
  patch: string,
  approvalHandler?: ApprovalHandler,
) {
  const registry = createToolRegistry(
    createActionableCodingTools({
      settings: {
        safeCommands: [],
        commandTimeoutMs: TEST_COMMAND_TIMEOUT_MS,
        maxPatchBytes: 100_000,
      },
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(),
      },
    }),
    {
      approvalHandler:
        approvalHandler ??
        (async () => ({
          status: "approved",
          reason: "Approved by test.",
          fullPatchShown: false,
        })),
    },
  );
  return registry.execute(
    { id: "call_patch", name: "apply_patch", input: { patch } },
    testContext(workspaceRoot, ["write_workspace"]),
  );
}

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
