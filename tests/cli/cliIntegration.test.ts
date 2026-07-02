import { expect, test } from "@jest/globals";
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
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
  const trace = await readFile(run.tracePath ?? "", "utf8");
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const started = events.find((event) => event.type === "session_started");
  const taskHash = started?.payload.taskHash;
  expect(taskHash).toMatch(/^[0-9a-f]{8}$/);
  expect(started?.payload).not.toHaveProperty("readScope");
  expect(list.stdout).toMatch(new RegExp(`\\b${taskHash}\\b`));
  expect(run.summary).toMatch(new RegExp(`Task hash: ${taskHash}`));

  const show = await runCli(["sessions", "show", run.session.id], {
    workspaceRoot,
  });
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toMatch(/Workflow: coding/);
  expect(show.stdout).toMatch(/Task: fix tests/);
  expect(show.stdout).toMatch(new RegExp(`Task hash: ${taskHash}`));
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
              inheritedForgeletChanged: ["src/old-greeting.ts"],
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
  expect(result.stdout).toMatch(/Inherited Forgelet changes: src\/old-greeting\.ts/);
  expect(result.stdout).toMatch(/Forgelet changed: src\/greeting\.ts/);
  expect(result.stdout).toMatch(/Pre-existing at Session start: README\.md/);
  expect(result.stdout).toMatch(
    /Other current workspace changes: package\.json/,
  );
  expect(result.stdout).toMatch(/Verification commands:/);
  expect(result.stdout).toMatch(/- npm test \(exit 1\)/);
  expect(result.stdout).toMatch(/Kernel-observed risks:/);
  expect(result.stdout).toMatch(
    /- Verification command failed: npm test \(exit 1\)\./,
  );
});

test("CLI explains an actionable session from grouped trace evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-explain-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_explain.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_explain",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_explain",
        payload: { task: "change the greeting" },
      }),
      JSON.stringify({
        type: "routing_selected",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_explain",
        payload: {
          workflow: "coding",
          stage: "act_loop",
          model: "deepseek-v4-flash",
          reason: "default route for coding workflow",
        },
      }),
      JSON.stringify({
        type: "model_turn",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_explain",
        payload: {
          turnIndex: 0,
          model: "deepseek-v4-flash",
          toolCalls: [{ id: "call_patch", name: "apply_patch" }],
          usage: { inputTokens: 100, outputTokens: 30, estimatedCostUsd: 0.01 },
        },
      }),
      JSON.stringify({
        type: "tool_call",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_explain",
        payload: {
          id: "call_patch",
          name: "apply_patch",
          input: { patch: "(redacted in test)" },
        },
      }),
      JSON.stringify({
        type: "permission_decision",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_explain",
        payload: {
          toolCallId: "call_patch",
          toolName: "apply_patch",
          capability: "write_workspace",
          decision: "confirm",
          riskTier: "medium",
          reason: "Medium risk requires approval.",
        },
      }),
      JSON.stringify({
        type: "approval_decision",
        ts: "2026-06-20T00:00:03.000Z",
        sessionId: "sess_explain",
        payload: {
          toolCallId: "call_patch",
          toolName: "apply_patch",
          status: "approved",
          reason: "Approved by user.",
        },
      }),
      JSON.stringify({
        type: "tool_result",
        ts: "2026-06-20T00:00:04.000Z",
        sessionId: "sess_explain",
        payload: {
          ok: true,
          toolCallId: "call_patch",
          toolName: "apply_patch",
          summary: "Applied patch to 1 file(s).",
          changedFiles: ["src/greeting.ts"],
        },
      }),
      JSON.stringify({
        type: "tool_result",
        ts: "2026-06-20T00:00:05.000Z",
        sessionId: "sess_explain",
        payload: {
          ok: true,
          toolCallId: "call_test",
          toolName: "run_command",
          summary: "Command exited 0.",
          command: "npm test",
          exitCode: 0,
          timedOut: false,
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:06.000Z",
        sessionId: "sess_explain",
        payload: {
          summary: "Changed src/greeting.ts.",
          audit: {
            changeGroups: {
              inheritedForgeletChanged: ["src/old-greeting.ts"],
              forgeletChanged: ["src/greeting.ts"],
              preExistingAtSessionStart: [],
              otherCurrentWorkspaceChanges: [],
            },
            verificationCommands: [
              { command: "npm test", exitCode: 0, timedOut: false },
            ],
            kernelObservedRisks: [],
            modelTurns: 1,
            estimatedCostUsd: 0.01,
            tracePath: ".forgelet/sessions/sess_explain.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:07.000Z",
        sessionId: "sess_explain",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["explain", "sess_explain"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Session explanation: sess_explain/);
  expect(result.stdout).toMatch(/What happened/);
  expect(result.stdout).toMatch(/Task: change the greeting/);
  expect(result.stdout).toMatch(
    /Route: deepseek-v4-flash \(default route for coding workflow\)/,
  );
  expect(result.stdout).toMatch(/Estimated cost: \$0\.0100/);
  expect(result.stdout).toMatch(/Tool use/);
  expect(result.stdout).toMatch(
    /- apply_patch: Applied patch to 1 file\(s\)\./,
  );
  expect(result.stdout).toMatch(/Permissions and approvals/);
  expect(result.stdout).toMatch(
    /- apply_patch requested write_workspace at medium risk: confirm/,
  );
  expect(result.stdout).toMatch(/- apply_patch approval: approved/);
  expect(result.stdout).toMatch(/Verification and risks/);
  expect(result.stdout).toMatch(/Inherited Forgelet changes: src\/old-greeting\.ts/);
  expect(result.stdout).toMatch(/- npm test \(exit 0\)/);
  expect(result.stdout).toMatch(/Forgelet changed: src\/greeting\.ts/);
  expect(result.stdout).toMatch(/Agent Kernel takeaways/);
  expect(result.stdout).toMatch(
    /Trace records the model turns, tool calls, permission decisions, results, and final audit/,
  );
});

test("CLI explain shows conversation compaction evidence", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-explain-compaction-"),
  );
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_compaction.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-24T00:00:00.000Z",
        sessionId: "sess_compaction",
        payload: { workflow: "coding" },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-24T00:00:00.000Z",
        sessionId: "sess_compaction",
        payload: { task: "inspect files" },
      }),
      JSON.stringify({
        type: "conversation_compacted",
        ts: "2026-06-24T00:00:01.000Z",
        sessionId: "sess_compaction",
        payload: {
          compactedCount: 3,
          beforeObservationBytes: 30_000,
          afterObservationBytes: 10_000,
          residualOverageBytes: 1_000,
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-24T00:00:02.000Z",
        sessionId: "sess_compaction",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["explain", "sess_compaction"], {
    workspaceRoot,
  });

  expect(result.stdout).toMatch(/Conversation compaction:/);
  expect(result.stdout).toMatch(/Passes: 1/);
  expect(result.stdout).toMatch(/Compacted observations: 3/);
  expect(result.stdout).toMatch(/Bytes removed: 20000/);
  expect(result.stdout).toMatch(/Maximum residual overage: 1000 bytes/);
});

test("CLI explains an incomplete session without inventing missing evidence", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-explain-incomplete-"),
  );
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_incomplete_explain.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_incomplete_explain",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_incomplete_explain",
        payload: { task: "inspect the repo" },
      }),
      JSON.stringify({
        type: "model_turn",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_incomplete_explain",
        payload: {
          turnIndex: 0,
          model: "deepseek-v4-flash",
          toolCalls: [{ id: "call_status", name: "git_status" }],
        },
      }),
      JSON.stringify({
        type: "tool_result",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_incomplete_explain",
        payload: {
          ok: true,
          toolCallId: "call_status",
          toolName: "git_status",
          summary: "Workspace has no changes.",
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["explain", "sess_incomplete_explain"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Session explanation: sess_incomplete_explain/);
  expect(result.stdout).toMatch(/Status: incomplete/);
  expect(result.stdout).toMatch(
    /Missing evidence: final_summary, session_finished/,
  );
  expect(result.stdout).toMatch(/- git_status: Workspace has no changes\./);
  expect(result.stdout).toMatch(/No final audit was recorded\./);
  expect(result.stdout).toMatch(/only uses recorded Session evidence/);
});

test("CLI creates a pending Memory Suggestion from actionable Session audit evidence", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-memory-suggest-"),
  );
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_memory.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_memory",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_memory",
        payload: { task: "change the greeting" },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_memory",
        payload: {
          summary: "Changed src/greeting.ts.",
          audit: {
            changeGroups: {
              forgeletChanged: ["src/greeting.ts"],
              preExistingAtSessionStart: [],
              otherCurrentWorkspaceChanges: [],
            },
            verificationCommands: [
              { command: "npm test", exitCode: 0, timedOut: false },
            ],
            kernelObservedRisks: [],
            modelTurns: 1,
            estimatedCostUsd: 0.01,
            tracePath: ".forgelet/sessions/sess_memory.jsonl",
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_memory",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["memory", "suggest", "sess_memory"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Memory suggestion: mem_/);
  expect(result.stdout).toMatch(/Source Session: sess_memory/);
  expect(result.stdout).toMatch(/npm test/);

  const store = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  const suggestion = JSON.parse(store.trim());
  expect(suggestion).toMatchObject({
    sourceSessionId: "sess_memory",
    status: "proposed",
  });
  expect(suggestion.text).toMatch(/npm test/);
});

test("CLI accepts a pending Memory Suggestion into Durable Memory", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-memory-accept-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    `${JSON.stringify({
      id: "mem_accept",
      sourceSessionId: "sess_memory",
      text: "In this workspace, use npm test as verification.",
      reason:
        "Derived deterministically from actionable Session audit evidence.",
      status: "proposed",
    })}\n`,
    "utf8",
  );

  const result = await runCli(["memory", "accept", "mem_accept"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Memory accepted: mem_accept/);

  const memory = await readFile(
    join(workspaceRoot, ".forgelet", "memory.md"),
    "utf8",
  );
  expect(memory).toMatch(/In this workspace, use npm test as verification\./);
  expect(memory).toMatch(/Source Session: sess_memory/);

  const store = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(JSON.parse(store.trim())).toMatchObject({
    id: "mem_accept",
    status: "accepted",
  });
});

test("CLI entrypoint runs when invoked through an npm-link style symlink", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-link-"));
  const linkedBin = join(workspaceRoot, "forge");
  await symlink(join(process.cwd(), "dist", "cli", "index.js"), linkedBin);

  const result = await execNode([linkedBin, "--help"], workspaceRoot);

  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Forgelet/);
  expect(result.stdout).toMatch(/--preview/);
  expect(result.stdout).not.toMatch(/--live/);
});

test("CLI preview prints run shape without creating a model-backed Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-preview-"));
  let modelFactoryCalled = false;

  const result = await runCli(["--preview", "inspect this repo"], {
    workspaceRoot,
    createLiveModelClient: async () => {
      modelFactoryCalled = true;
      throw new Error("model factory should not be called for preview");
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelFactoryCalled).toBe(false);
  expect(result.stdout).toMatch(/Session Preview/);
  expect(result.stdout).toMatch(/Workflow: coding/);
  expect(result.stdout).toMatch(/Task: inspect this repo/);
  expect(result.stdout).toMatch(
    /Model route: deepseek-v4-flash \(default route for coding workflow\)/,
  );
  expect(result.stdout).toMatch(/Runnable: yes/);
  expect(result.stdout).toMatch(/Required provider env var: DEEPSEEK_API_KEY/);
  expect(result.stdout).toMatch(
    /Persistence: none; no Session or Trace will be created/,
  );
  await expect(readdir(join(workspaceRoot, ".forgelet", "sessions"))).rejects.toThrow();
});

test("CLI preview reports action posture, read scope, context, and budget", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-preview-act-"));
  let approvalRequested = false;

  const result = await runCli(
    [
      "--preview",
      "--act",
      "--context",
      "issue.md",
      "--allow-read",
      "src",
      "--budget",
      "0.10",
      "fix the failing test",
    ],
    {
      workspaceRoot,
      approvalHandler: async () => {
        approvalRequested = true;
        return { status: "approved", reason: "unused" };
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(approvalRequested).toBe(false);
  expect(result.stdout).toMatch(/Session Preview/);
  expect(result.stdout).toMatch(/Budget: \$0\.10 requested/);
  expect(result.stdout).toMatch(/Action mode: action-capable; approvals required/);
  expect(result.stdout).toMatch(/Read scope: src/);
  expect(result.stdout).toMatch(/Context attachments: issue\.md/);
  expect(result.stdout).toMatch(/patch requests, configured command requests/);
});

test("CLI preview succeeds for unsupported provider routes as not runnable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-preview-route-"));

  const result = await runCli(
    ["--preview", "--model", "gpt-5", "inspect this repo"],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Model route: gpt-5 \(CLI model override\)/);
  expect(result.stdout).toMatch(/Runnable: no/);
  expect(result.stdout).toMatch(/Runnable reason: .*DeepSeek routes only/);
  expect(result.stdout).toMatch(/Required provider env var: OPENAI_API_KEY/);
});

test("CLI preview reports creative writing variants without persistence", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-preview-writing-"),
  );

  const result = await runCli(
    [
      "write",
      "--preview",
      "--creative",
      "--style",
      "vivid",
      "write a rain-soaked convenience store scene",
    ],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Session Preview/);
  expect(result.stdout).toMatch(/Workflow: writing/);
  expect(result.stdout).toMatch(/Workflow variant: creative/);
  expect(result.stdout).toMatch(/Creative input kind: draft/);
  expect(result.stdout).toMatch(/Creative style: vivid/);
  expect(result.stdout).toMatch(/Action mode: not available for writing/);
  expect(result.stdout).toMatch(/Capabilities: model text generation and plan updates/);
  expect(result.stdout).toMatch(
    /Persistence: none; no Session or Trace will be created/,
  );
  await expect(readdir(join(workspaceRoot, ".forgelet", "sessions"))).rejects.toThrow();
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
  expect(config.defaultModel).toBe("deepseek-v4-flash");
  expect(config.routing.coding.default).toBe("deepseek-v4-flash");
});

test("CLI sets narrow user config values", async () => {
  const homeDir = await mkdtemp(
    join(tmpdir(), "forgelet-cli-config-set-home-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-config-set-"),
  );

  const setMemory = await runCli(
    ["config", "set", "memoryFile", ".forgelet/custom-memory.md"],
    { homeDir, workspaceRoot },
  );
  const setProvider = await runCli(
    ["config", "set", "providers.deepseek.apiKeyEnv", "CUSTOM_DEEPSEEK_KEY"],
    { homeDir, workspaceRoot },
  );
  const get = await runCli(["config", "get"], { homeDir, workspaceRoot });
  const config = JSON.parse(get.stdout);

  expect(setMemory.exitCode).toBe(0);
  expect(setMemory.stdout).toMatch(
    /Config set: memoryFile=.forgelet\/custom-memory\.md/,
  );
  expect(setProvider.exitCode).toBe(0);
  expect(setProvider.stdout).toMatch(
    /Config set: providers\.deepseek\.apiKeyEnv=CUSTOM_DEEPSEEK_KEY/,
  );
  expect(config.memoryFile).toBe(".forgelet/custom-memory.md");
  expect(config.providers.deepseek.apiKeyEnv).toBe("CUSTOM_DEEPSEEK_KEY");
});

test("CLI rejects unsupported V1 config set keys", async () => {
  const homeDir = await mkdtemp(
    join(tmpdir(), "forgelet-cli-config-reject-home-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-config-reject-"),
  );

  const result = await runCli(["config", "set", "safeCommands", "npm test"], {
    homeDir,
    workspaceRoot,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Unsupported config key for V1: safeCommands/);
  expect(result.stderr).toMatch(/Supported keys: memoryFile/);
});

test("CLI sets the global active observation working-set target", async () => {
  const homeDir = await mkdtemp(
    join(tmpdir(), "forgelet-cli-active-context-home-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-active-context-"),
  );

  const set = await runCli(
    ["config", "set", "activeContext.maxObservationBytes", "65536"],
    { homeDir, workspaceRoot },
  );
  const get = await runCli(["config", "get"], { homeDir, workspaceRoot });

  expect(set.exitCode).toBe(0);
  expect(JSON.parse(get.stdout).activeContext.maxObservationBytes).toBe(65_536);
});

test("CLI sets the global observation digest preview cap", async () => {
  const homeDir = await mkdtemp(
    join(tmpdir(), "forgelet-cli-digest-preview-home-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-digest-preview-"),
  );

  const set = await runCli(
    ["config", "set", "activeContext.observationDigestPreviewBytes", "3072"],
    { homeDir, workspaceRoot },
  );
  const get = await runCli(["config", "get"], { homeDir, workspaceRoot });

  expect(set.exitCode).toBe(0);
  expect(JSON.parse(get.stdout).activeContext.observationDigestPreviewBytes).toBe(
    3_072,
  );
});

test("CLI help documents the active observation config key", async () => {
  const result = await runCli(["--help"]);

  expect(result.stdout).toMatch(
    /forge config set activeContext\.maxObservationBytes 16384/,
  );
  expect(result.stdout).toMatch(
    /forge config set activeContext\.observationDigestPreviewBytes 2048/,
  );
  expect(result.stdout).toMatch(/forge resume <sessionId> --act "<instruction>"/);
  expect(result.stdout).toMatch(
    /forge write --creative --style vivid --continue \.forgelet\/writing\/chapter-1\.md "continue the next chapter"/,
  );
  expect(result.stdout).toMatch(
    /config set supports memoryFile, activeContext config keys, and provider API key env vars/,
  );
});

test("CLI rejects an invalid active observation working-set target", async () => {
  const homeDir = await mkdtemp(
    join(tmpdir(), "forgelet-cli-active-context-invalid-home-"),
  );
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-active-context-invalid-"),
  );

  const result = await runCli(
    ["config", "set", "activeContext.maxObservationBytes", "4095"],
    { homeDir, workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(
    /activeContext\.maxObservationBytes.*at least 4096/,
  );
});

test("CLI invalid Writing Artifact Continuation paths point users toward saved artifacts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-writing-continuation-error-"));

  const result = await runCli(
    [
      "write",
      "--creative",
      "--style",
      "vivid",
      "--continue",
      ".forgelet/writing/missing.md",
      "continue the next chapter",
    ],
    {
      workspaceRoot,
    },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Unable to read continuation artifact/);
  expect(result.stderr).toMatch(/\.forgelet\/writing\//);
});

test("CLI resume runs a live read-only Session Continuation by default", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-resume-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_parent.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: { task: "remember cobalt" },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: { summary: "The inherited fact is cobalt." },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Continuing with cobalt.", toolCalls: [] },
  ]);

  const result = await runCli(["resume", "sess_parent", "continue"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async (input) => {
      expect(input.workflow).toBe("coding");
      expect(input.modelOverride).toBe(undefined);
      return modelClient;
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Continuation: sess_parent -> sess_/);
  expect(result.stdout).toMatch(/Lineage depth: 1/);
  expect(result.stdout).toMatch(/Context: complete/);
  expect(result.stdout).toMatch(/Continuing with cobalt/);
  expect(result.stdout).toMatch(/Trace: .*\.forgelet\/sessions\/sess_/);
  expect(modelClient.turnInputs[0]?.messages.map((message) => message.content).join("\n")).toMatch(
    /Continuation Context:/,
  );
});

test("CLI resume --act runs an actionable Session Continuation with current approval", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-resume-act-"),
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

  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  const parentTracePath = join(sessionDir, "sess_parent.jsonl");
  await writeFile(
    parentTracePath,
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_parent",
        payload: { task: "start the fix" },
      }),
      JSON.stringify({
        type: "permission_decision",
        ts: "2026-06-20T00:00:01.000Z",
        sessionId: "sess_parent",
        payload: {
          toolCallId: "parent_patch",
          toolName: "apply_patch",
          capability: "write_workspace",
          decision: "confirm",
        },
      }),
      JSON.stringify({
        type: "approval_decision",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: {
          toolCallId: "parent_patch",
          toolName: "apply_patch",
          status: "approved",
          reason: "Approved in parent Session.",
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-06-20T00:00:03.000Z",
        sessionId: "sess_parent",
        payload: { summary: "Parent gathered actionable evidence." },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:04.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  const parentBefore = await readFile(parentTracePath, "utf8");

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
      toolCalls: [{ id: "child_patch", name: "apply_patch", input: { patch } }],
    },
    {
      toolCalls: [
        { id: "child_command", name: "run_command", input: { command } },
      ],
    },
    { content: "Finished the continuation.", toolCalls: [] },
  ]);
  const approvalRequests: string[] = [];

  const result = await runCli(
    ["resume", "sess_parent", "--act", "finish the fix"],
    {
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => modelClient,
      approvalHandler: async (request) => {
        approvalRequests.push(request.toolCall.name);
        return {
          status: "approved",
          reason: "Approved in child Session.",
        };
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Continuation: sess_parent -> sess_/);
  await expect(readFile(join(workspaceRoot, "example.txt"), "utf8")).resolves.toBe(
    "changed\n",
  );
  expect(approvalRequests).toEqual(["apply_patch", "run_command"]);
  await expect(readFile(parentTracePath, "utf8")).resolves.toBe(parentBefore);

  const traceFiles = await readdir(sessionDir);
  const childTraceFile = traceFiles.find((entry) => entry !== "sess_parent.jsonl");
  expect(childTraceFile).toBeDefined();
  const childTrace = await readFile(
    join(sessionDir, childTraceFile ?? ""),
    "utf8",
  );
  const childEvents = childTrace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(childEvents.some((event) => event.type === "session_continuation_started")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "continuation_context_loaded")).toBe(
    true,
  );
  expect(childEvents.some((event) => event.type === "workspace_baseline")).toBe(
    true,
  );
  expect(
    childEvents.filter((event) => event.type === "approval_decision"),
  ).toHaveLength(2);
});

test("CLI resume rejects Writing Workflow Sessions in the first slice", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-resume-writing-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_writing.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:00:00.000Z",
        sessionId: "sess_writing",
        payload: {
          workflow: "writing",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_writing",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["resume", "sess_writing", "continue"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () =>
      new FakeModelClient([{ content: "should not run", toolCalls: [] }]),
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Writing Workflow resume is not available yet/);
});

test("CLI records repeated --allow-read entries as the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-read-scope-"),
  );
  await mkdir(join(workspaceRoot, "src", "workflows"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "Forgelet\n", "utf8");
  const result = await runCli(
    [
      "--allow-read",
      "./README.md",
      "--allow-read",
      "src/workflows/",
      "inspect allowed files",
    ],
    {
      workspaceRoot,
    },
  );

  expect(result.exitCode).toBe(0);
  const tracePath = result.stdout.match(/Trace: (.+)$/m)?.[1];
  const events = (await readFile(tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "session_started")?.payload
      .readScope,
  ).toEqual(["README.md", "src/workflows"]);
});

test("CLI rejects absolute Session Read Scope paths", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-absolute-read-scope-"),
  );
  const allowedPath = join(workspaceRoot, "README.md");
  await writeFile(allowedPath, "Forgelet\n", "utf8");

  const result = await runCli(
    ["--allow-read", allowedPath, "inspect allowed files"],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/--allow-read paths must be workspace-relative/);
});

test("CLI rejects the removed --live option before provider validation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-live-key-"));

  const result = await runCli(["--live", "inspect repo"], {
    workspaceRoot,
    env: {},
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Unknown option: --live/);
});

test("CLI rejects the removed --live option before route validation", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-live-route-"),
  );

  const result = await runCli(["--live", "--model", "gpt-5", "inspect repo"], {
    workspaceRoot,
    env: { DEEPSEEK_API_KEY: "test-key" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Unknown option: --live/);
});
