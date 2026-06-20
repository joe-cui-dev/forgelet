import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "../../src/agent/runAgent.js";
import { runCli } from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

test("CLI lists and shows project sessions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-"));
  const run = await runAgent({
    workflow: "coding",
    task: "fix tests",
    contextFiles: [],
    workspaceRoot,
  });

  const list = await runCli(["sessions", "list"], { workspaceRoot });
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toMatch(new RegExp(run.session.id));
  expect(list.stdout).toMatch(/completed/);

  const show = await runCli(["sessions", "show", run.session.id], {
    workspaceRoot,
  });
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toMatch(/Workflow: coding/);
  expect(show.stdout).toMatch(/Task: fix tests/);
  expect(show.stdout).toMatch(/Execution is scaffolded/);
});

test("CLI shows concise audit highlights for an actionable session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-audit-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_audit.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_audit",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_audit",
        payload: { task: "change the greeting" },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_audit",
        payload: {
          summary: "Changed src/greeting.ts.",
          audit: {
            changeGroups: {
              forgeletChanged: ["src/greeting.ts"],
              preExistingAtSessionStart: ["README.md"],
              otherCurrentWorkspaceChanges: ["package.json"],
            },
            verificationCommands: [
              { command: "npm test", exitCode: 1, timedOut: false },
            ],
            kernelObservedRisks: [
              {
                kind: "verification_failed",
                message: "Verification command failed: npm test (exit 1).",
                command: "npm test",
                exitCode: 1,
              },
            ],
            modelTurns: 4,
            estimatedCostUsd: 0.0123,
            tracePath: ".forgelet/sessions/sess_audit.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_audit",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["sessions", "show", "sess_audit"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Audit:/);
  expect(result.stdout).toMatch(/Forgelet changed: src\/greeting\.ts/);
  expect(result.stdout).toMatch(/Pre-existing at Session start: README\.md/);
  expect(result.stdout).toMatch(/Other current workspace changes: package\.json/);
  expect(result.stdout).toMatch(/Verification commands:/);
  expect(result.stdout).toMatch(/- npm test \(exit 1\)/);
  expect(result.stdout).toMatch(/Kernel-observed risks:/);
  expect(result.stdout).toMatch(/- Verification command failed: npm test \(exit 1\)\./);
});

test("CLI entrypoint runs when invoked through an npm-link style symlink", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-link-"));
  const linkedBin = join(workspaceRoot, "forge");
  await symlink(join(process.cwd(), "dist", "cli", "index.js"), linkedBin);

  const result = await execNode([linkedBin, "--help"], workspaceRoot);

  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Forgelet/);
  expect(result.stdout).toMatch(/--live/);
});

function execNode(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        rejectExec(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

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

test("CLI prints merged config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-config-"));
  await mkdir(join(homeDir, ".forgelet"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "config.json"),
    JSON.stringify({ defaultModel: "custom-pro" }),
    "utf8",
  );

  const result = await runCli(["config", "get"], { homeDir, workspaceRoot });
  const config = JSON.parse(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(config.defaultModel).toBe("deepseek-v4-pro");
  expect(config.routing.coding.default).toBe("deepseek-v4-pro");
});

test("CLI --live runs a read-only Session with an injected live model client", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-live-"));
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
    { content: "Found needle in example.ts.", toolCalls: [] },
  ]);

  const result = await runCli(["--live", "find needle"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async (input) => {
      expect(input.workflow).toBe("coding");
      expect(input.modelOverride).toBe(undefined);
      return modelClient;
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Forgelet session completed/);
  expect(result.stdout).toMatch(/Found needle in example.ts/);
  expect(modelClient.turnInputs.length).toBe(2);
});

test("CLI --live --act runs an actionable coding Session with injected approval", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-act-"));
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
    { toolCalls: [{ id: "call_patch", name: "apply_patch", input: { patch } }] },
    {
      toolCalls: [
        { id: "call_command", name: "run_command", input: { command } },
      ],
    },
    { content: "Changed example.txt.", toolCalls: [] },
  ]);

  const result = await runCli(["--live", "--act", "change example"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () => modelClient,
    approvalHandler: async () => ({
      status: "approved",
      reason: "Approved by test.",
    }),
  });

  expect(result.exitCode).toBe(0);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "changed\n",
  );
  expect(result.stdout).toMatch(/Changed example\.txt/);
});

test("CLI --live requires a DeepSeek API key", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-live-key-"));

  const result = await runCli(["--live", "inspect repo"], {
    workspaceRoot,
    env: {},
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/DEEPSEEK_API_KEY is required for --live DeepSeek execution/);
});

test("CLI --live rejects non-DeepSeek routes", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-live-route-"),
  );

  const result = await runCli(["--live", "--model", "gpt-5", "inspect repo"], {
    workspaceRoot,
    env: { DEEPSEEK_API_KEY: "test-key" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Live execution currently supports DeepSeek models only/);
});
