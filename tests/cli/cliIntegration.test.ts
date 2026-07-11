import { expect, test } from "@jest/globals";
import { createHash } from "node:crypto";
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runCodingSession } from "../../src/workflows/coding.js";
import {
  createInteractiveTerminalOutputController,
  runCli,
} from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

function memorySuggestionId(sourceSessionId: string, text: string): string {
  return `mem_${createHash("sha256")
    .update(`${sourceSessionId}\n${text}`)
    .digest("hex")
    .slice(0, 12)}`;
}

test("CLI lists and shows project sessions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-"));
  const run = await runCodingSession({
    task: "fix tests",
    contextFiles: [],
    workspaceRoot,
    modelClient: new FakeModelClient([
      { content: "Fixed tests summary.", toolCalls: [] },
    ]),
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
  expect(show.stdout).toMatch(/Fixed tests summary/);
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
          beforeConversationBytes: 30_000,
          afterConversationBytes: 10_000,
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
    schemaVersion: 1,
    sourceSessionId: "sess_memory",
    provenance: {
      trace: expect.objectContaining({ path: ".forgelet/sessions/sess_memory.jsonl" }),
    },
  });
  expect(suggestion).not.toHaveProperty("status");
  expect(suggestion.text).toMatch(/npm test/);

  const repeated = await runCli(["memory", "suggest", "sess_memory"], {
    workspaceRoot,
  });
  expect(repeated.exitCode).toBe(0);
  expect(repeated.stdout).toContain(`Memory suggestion: ${suggestion.id}`);
  expect(repeated.stdout).toContain("State: proposed");
  expect(repeated.stdout).toContain("Recorded: existing proposal.");
  expect(await readFile(join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"), "utf8"))
    .toBe(store);
});

test("CLI accepts a pending Memory Suggestion into Durable Memory", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-memory-accept-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const suggestionLine = `${JSON.stringify({
    id: "mem_accept",
    sourceSessionId: "sess_memory",
    text: "In this workspace, use npm test as verification.",
    reason:
      "Derived deterministically from actionable Session audit evidence.",
    status: "proposed",
  })}\n`;
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    suggestionLine,
    "utf8",
  );

  const result = await runCli(["memory", "accept", "mem_accept"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Accepted: mem_accept/);
  expect(result.stdout).toMatch(/Durable Memory: \.forgelet\/memory\.md/);
  expect(result.stdout).toMatch(/Evidence: \.forgelet\/memory-decisions\.jsonl/);

  const memory = await readFile(
    join(workspaceRoot, ".forgelet", "memory.md"),
    "utf8",
  );
  expect(memory).toMatch(/In this workspace, use npm test as verification\./);
  expect(memory).toMatch(/Source Session: sess_memory/);

  // The suggestions file is append-only evidence and is never rewritten by
  // acceptance; current state comes from the Memory Decision Log instead.
  const store = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(store).toBe(suggestionLine);

  const log = (
    await readFile(join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toEqual([
    expect.objectContaining({ type: "decision", suggestionId: "mem_accept", decision: "accepted" }),
    expect.objectContaining({ type: "write-record", suggestionId: "mem_accept", path: ".forgelet/memory.md" }),
  ]);
});

test("CLI rejects a pending Memory Suggestion without writing Durable Memory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-memory-reject-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    `${JSON.stringify({
      id: "mem_reject",
      sourceSessionId: "sess_memory",
      text: "Guidance nobody wants.",
      reason: "Derived deterministically.",
      status: "proposed",
    })}\n`,
    "utf8",
  );

  const result = await runCli(["memory", "reject", "mem_reject"], { workspaceRoot });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Rejected: mem_reject/);
  await expect(
    readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const repeat = await runCli(["memory", "reject", "mem_reject"], { workspaceRoot });
  expect(repeat.exitCode).toBe(0);
  expect(repeat.stdout).toMatch(/Already decided/);

  const conflict = await runCli(["memory", "accept", "mem_reject"], { workspaceRoot });
  expect(conflict.exitCode).toBe(1);
  expect(conflict.stderr).toMatch(/already rejected/);
});

test("CLI lists actionable Project Memory Review items with guided next actions", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-memory-list-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const legacyAcceptedText = "In this workspace, use npm test as verification.";
  const newText = "New guidance awaiting review.";
  const newId = memorySuggestionId("sess_new", newText);
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    [
      JSON.stringify({
        id: "mem_oldaccept",
        sourceSessionId: "sess_old",
        text: legacyAcceptedText,
        reason: "Derived deterministically.",
        status: "accepted",
      }),
      JSON.stringify({
        id: "mem_oldgap",
        sourceSessionId: "sess_gap",
        text: "Legacy accepted whose block is gone.",
        reason: "Derived deterministically.",
        status: "accepted",
      }),
      JSON.stringify({
        schemaVersion: 1,
        id: newId,
        sourceSessionId: "sess_new",
        text: newText,
        createdAt: "2026-07-10T09:00:00Z",
        provenance: {
          derivation: {
            changedFiles: { items: [], total: 0 },
            successfulVerificationCommands: { items: [], total: 0 },
          },
          trace: {
            path: ".forgelet/sessions/sess_missing.jsonl",
            sha256: "0".repeat(64),
            bytes: 1,
          },
          session: {
            workflow: "coding",
            status: "completed",
            startedAt: "2026-07-10T09:00:00Z",
            finishedAt: "2026-07-10T09:00:00Z",
          },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory.md"),
    `## mem_oldaccept\n\n${legacyAcceptedText}\n`,
    "utf8",
  );
  const suggestionsBefore = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );

  const list = await runCli(["memory", "list"], { workspaceRoot });
  expect(list.exitCode).toBe(0);
  expect(list.stderr).toBe("");
  const gapIndex = list.stdout.indexOf(
    "Accepted, but not written — re-accept to repair",
  );
  const proposedIndex = list.stdout.indexOf("Proposed — awaiting your review");
  expect(gapIndex).toBeGreaterThanOrEqual(0);
  expect(proposedIndex).toBeGreaterThan(gapIndex);
  expect(list.stdout).toContain("Next: forge memory accept mem_oldgap");
  expect(list.stdout).toContain(`Next: forge memory show ${newId}`);
  expect(list.stdout).toContain("Created: 2026-07-10T09:00:00Z");
  expect(list.stdout).toContain("Created: -");
  expect(list.stdout).not.toContain("mem_oldaccept");

  const all = await runCli(["memory", "list", "--all"], { workspaceRoot });
  expect(all.exitCode).toBe(0);
  expect(all.stdout).toContain("Accepted and written");
  expect(all.stdout).toContain("mem_oldaccept");
  expect(all.stdout.indexOf("mem_oldaccept")).toBeLessThan(
    all.stdout.indexOf("mem_oldgap"),
  );

  // Compatibility Import appended evidence without rewriting the suggestions file.
  const suggestionsAfter = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(suggestionsAfter).toBe(suggestionsBefore);
  const log = (
    await readFile(
      join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(log).toEqual([
    expect.objectContaining({
      type: "decision",
      suggestionId: "mem_oldaccept",
      decision: "accepted",
      origin: "legacy-status",
    }),
    expect.objectContaining({
      type: "write-record",
      suggestionId: "mem_oldaccept",
      origin: "found-existing",
    }),
    expect.objectContaining({
      type: "decision",
      suggestionId: "mem_oldgap",
      decision: "accepted",
      origin: "legacy-status",
    }),
  ]);
});

test("CLI memory list shows the settled empty states", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-memory-empty-"),
  );

  const empty = await runCli(["memory", "list"], { workspaceRoot });
  expect(empty.exitCode).toBe(0);
  expect(empty.stdout).toBe("No pending memory suggestions.");

  const emptyAll = await runCli(["memory", "list", "--all"], { workspaceRoot });
  expect(emptyAll.exitCode).toBe(0);
  expect(emptyAll.stdout).toBe("No memory suggestions.");

  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    `${JSON.stringify({
      id: "mem_done",
      sourceSessionId: "sess_done",
      text: "Already rejected.",
      reason: "r",
      status: "rejected",
    })}\n`,
    "utf8",
  );
  const decidedOnly = await runCli(["memory", "list"], { workspaceRoot });
  expect(decidedOnly.exitCode).toBe(0);
  expect(decidedOnly.stdout).toBe(
    [
      "No pending memory suggestions.",
      "1 decided suggestion recorded. Run forge memory list --all to include it.",
    ].join("\n"),
  );
});

test("CLI memory list fails on corrupt evidence naming the file and line with no partial output", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-memory-corrupt-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    [
      JSON.stringify({
        id: "mem_fine",
        sourceSessionId: "sess_a",
        text: "Fine.",
        reason: "r",
        status: "proposed",
      }),
      "{broken",
    ].join("\n") + "\n",
    "utf8",
  );

  const result = await runCli(["memory", "list"], { workspaceRoot });
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(
    /forge: .*\.forgelet\/memory-suggestions\.jsonl at line 2/,
  );
});

test("CLI memory show presents the guided evidence view without starting a Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-memory-show-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const text = "Remember the verification command.";
  const suggestionId = memorySuggestionId("sess_show", text);
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: suggestionId,
      sourceSessionId: "sess_show",
      text,
      createdAt: "2026-07-10T09:00:00Z",
      provenance: {
        derivation: {
          changedFiles: { items: ["src/a.ts"], total: 1 },
          successfulVerificationCommands: { items: ["npm test"], total: 1 },
        },
        trace: { path: ".forgelet/sessions/missing.jsonl", sha256: "0".repeat(64), bytes: 1 },
        session: {
          workflow: "coding",
          status: "completed",
          startedAt: "2026-07-10T08:00:00Z",
          finishedAt: "2026-07-10T08:01:00Z",
        },
      },
    })}\n`,
    "utf8",
  );

  const result = await runCli(["memory", "show", suggestionId], { workspaceRoot });

  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  expect(result.stdout).toContain("What Forgelet wants to remember");
  expect(result.stdout).toContain("Why it was suggested");
  expect(result.stdout).toContain("Trace Corroboration: missing");
  expect(result.stdout).toContain("Exactly what acceptance will add");
  expect(result.stdout).toContain("--- begin rendered memory block ---");
  expect(result.stdout).toContain("Your choice");
  expect(result.stdout).toContain(`Accept: forge memory accept ${suggestionId}`);
  expect(result.stdout).toContain(`Reject: forge memory reject ${suggestionId}`);
  expect(result.stdout).toContain(`Id: ${suggestionId}   Status: proposed`);
  await expect(readFile(join(workspaceRoot, ".forgelet", "sessions", "anything.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const missing = await runCli(["memory", "show", "mem_nope"], { workspaceRoot });
  expect(missing).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "forge: Memory suggestion not found: mem_nope",
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

  const result = await runCli(["code", "--preview", "inspect this repo"], {
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
      "code",
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

test("CLI preview reports a source-backed learning workflow without persistence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-preview-learn-"));
  let modelFactoryCalled = false;

  const result = await runCli(
    ["learn", "--preview", "--context", "paper.md", "teach me the core ideas"],
    {
      workspaceRoot,
      createLiveModelClient: async () => {
        modelFactoryCalled = true;
        throw new Error("model factory should not be called for preview");
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(modelFactoryCalled).toBe(false);
  expect(result.stdout).toMatch(/Session Preview/);
  expect(result.stdout).toMatch(/Workflow: learning/);
  expect(result.stdout).toMatch(/Task: teach me the core ideas/);
  expect(result.stdout).toMatch(
    /Model route: deepseek-v4-flash \(default route for learning workflow\)/,
  );
  expect(result.stdout).toMatch(/Action mode: not available for learning/);
  expect(result.stdout).toMatch(/Read scope: not available for learning/);
  expect(result.stdout).toMatch(/Context attachments: paper\.md/);
  expect(result.stdout).toMatch(
    /source context, model text generation, and plan updates; no workspace, Git, patch, command, note-writing, or browser automation tools/,
  );
  expect(result.stdout).toMatch(
    /Persistence: none; no Session or Trace will be created/,
  );
  await expect(readdir(join(workspaceRoot, ".forgelet", "sessions"))).rejects.toThrow();
});

test("CLI runs a source-backed learning workflow and does not write Knowledge Library notes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-learn-"));
  await writeFile(join(workspaceRoot, "paper.md"), "# Paper\nSource text.\n", "utf8");

  const result = await runCli(
    ["learn", "--context", "paper.md", "teach me the core ideas"],
    {
      workspaceRoot,
      createLiveModelClient: async () =>
        new FakeModelClient([
          { content: "These are the core ideas.", toolCalls: [] },
        ]),
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Workflow: learning/);
  expect(result.stdout).toMatch(/## Summary\nThese are the core ideas\./);
  expect(result.stdout).toMatch(/## Source Links/);
  expect(result.stdout).toMatch(/- file: paper\.md/);
  expect(result.stdout).toMatch(/Trace: /);
  const traceFiles = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
  expect(traceFiles).toHaveLength(1);
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", traceFiles[0] ?? ""),
    "utf8",
  );
  const events = trace
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events[0]?.payload.workflow).toBe("learning");
  expect(events.some((event) => event.type === "context_attachment")).toBe(true);
  const finalSummary = events.find((event) => event.type === "final_summary");
  expect(finalSummary?.payload.summary).toMatch(/## Review Prompts/);
  expect(finalSummary?.payload.finalContent).toMatch(/## Summary\nThese are the core ideas\./);
  expect(finalSummary?.payload.finalContent).not.toMatch(/Forgelet session completed/);
  expect(finalSummary?.payload.finalContent).not.toMatch(/Trace: /);
  const sessionId = events[0]?.sessionId;
  const show = await runCli(["sessions", "show", sessionId], { workspaceRoot });
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toMatch(/Workflow: learning/);
  expect(show.stdout).toMatch(/Context attachments: paper\.md/);
  const explain = await runCli(["explain", sessionId], { workspaceRoot });
  expect(explain.exitCode).toBe(0);
  expect(explain.stdout).toMatch(new RegExp(`Session explanation: ${sessionId}`));
  expect(explain.stdout).toMatch(/Workflow: learning/);
  await expect(readdir(join(workspaceRoot, ".forgelet", "knowledge"))).rejects.toThrow();
});

test("CLI debug mode writes a Debug Transcript for a model-backed Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-debug-"));

  const result = await runCli(["code", "--debug", "inspect this repo"], {
    workspaceRoot,
    createLiveModelClient: async () =>
      new FakeModelClient([
        { content: "The repo is ready.", toolCalls: [], finishReason: "stop" },
      ]),
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Trace: /);
  const traceFiles = await readdir(join(workspaceRoot, ".forgelet", "sessions"));
  const debugTrace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", traceFiles[0] ?? ""),
    "utf8",
  );
  const sessionId = JSON.parse(debugTrace.split("\n")[0] ?? "{}").sessionId;
  const transcript = await readFile(
    join(workspaceRoot, ".forgelet", "debug", `${sessionId}.jsonl`),
    "utf8",
  );
  expect(transcript).toContain('"type":"model_request"');
  expect(transcript).toContain('"type":"model_response"');
  expect(transcript).toContain("inspect this repo");
  expect(debugTrace).toContain('"type":"debug_transcript_finished"');
});

test("CLI shows Debug Transcript previews and full content", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-debug-show-"));
  await mkdir(join(workspaceRoot, ".forgelet", "debug"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "debug", "sess_debug.jsonl"),
    [
      JSON.stringify({
        type: "model_request",
        ts: "2026-07-05T00:00:00.000Z",
        sessionId: "sess_debug",
        payload: {
          turnIndex: 0,
          model: "deepseek-v4-flash",
          messages: [
            { role: "system", content: `${"system ".repeat(120)}END` },
            { role: "user", content: "User task with secret detail." },
          ],
          tools: [{ name: "read_file" }, { name: "search_text" }],
          finalOnly: false,
        },
      }),
      JSON.stringify({
        type: "model_response",
        ts: "2026-07-05T00:00:01.000Z",
        sessionId: "sess_debug",
        payload: {
          turnIndex: 0,
          finishReason: "tool_calls",
          content: "I will inspect the file.",
          toolCalls: [{ id: "call_1", name: "read_file", input: { path: "README.md" } }],
        },
      }),
      JSON.stringify({
        type: "tool_result",
        ts: "2026-07-05T00:00:02.000Z",
        sessionId: "sess_debug",
        payload: {
          turnIndex: 0,
          toolCallId: "call_1",
          toolName: "read_file",
          observation: {
            ok: true,
            summary: "Read README.md.",
            content: "Full README observation content.",
          },
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const preview = await runCli(["debug", "show", "sess_debug"], { workspaceRoot });
  const full = await runCli(["debug", "show", "sess_debug", "--full"], {
    workspaceRoot,
  });
  const missing = await runCli(["debug", "show", "sess_missing"], {
    workspaceRoot,
  });

  expect(preview.exitCode).toBe(0);
  expect(preview.stdout).toMatch(/Debug Transcript/);
  expect(preview.stdout).toMatch(/Session: sess_debug/);
  expect(preview.stdout).toMatch(/Path: \.forgelet\/debug\/sess_debug\.jsonl/);
  expect(preview.stdout).toMatch(/Events: 3/);
  expect(preview.stdout).toMatch(/Model request: 2 messages, 2 tools/);
  expect(preview.stdout).toMatch(/Tools: read_file, search_text/);
  expect(preview.stdout).toMatch(/Tool result: read_file ok/);
  expect(preview.stdout).toMatch(/Full README observation content/);
  expect(preview.stdout).not.toContain("END");
  expect(full.exitCode).toBe(0);
  expect(full.stdout).toContain("END");
  expect(full.stdout).toContain("User task with secret detail.");
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toMatch(/Debug Transcript not found for Session: sess_missing/);
  expect(missing.stderr).toMatch(/Expected: \.forgelet\/debug\/sess_missing\.jsonl/);
});

test("CLI prints the current browser snapshot metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-home-"));
  await mkdir(join(homeDir, ".forgelet", "browser"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "browser", "current-page.json"),
    JSON.stringify(
      {
        url: "https://example.com/issue/123",
        title: "Fix checkout bug",
        capturedAt: new Date().toISOString(),
        selectedText: "The checkout button throws after payment auth.",
        mainText: "Longer page text that should not be used while selected text exists.",
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runCli(["browser", "read-current"], {
    homeDir,
    workspaceRoot,
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Browser Context Snapshot/);
  expect(result.stdout).toMatch(/URL: https:\/\/example\.com\/issue\/123/);
  expect(result.stdout).toMatch(/Title: Fix checkout bug/);
  expect(result.stdout).toMatch(/Content: selectedText/);
  expect(result.stdout).toMatch(/Content bytes: 46/);
});

test("CLI installs the Chrome Native Messaging host manifest", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-host-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-host-home-"));

  const result = await runCli(
    [
      "browser",
      "install-host",
      "--extension-id",
      "abcdefghijklmnopabcdefghijklmnop",
    ],
    { homeDir, workspaceRoot },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Chrome Native Messaging host installed/);
  const manifestPath = join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    "com.forgelet.browser_context.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(manifest).toEqual({
    name: "com.forgelet.browser_context",
    description: "Forgelet browser context snapshot producer",
    path: join(
      homeDir,
      ".forgelet",
      "browser",
      "native-host",
      "forgelet-browser-host",
    ),
    type: "stdio",
    allowed_origins: ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"],
  });
});

test("CLI preview with browser context shows the browser source before a Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-preview-"));
  const homeDir = await mkdtemp(
    join(tmpdir(), "forgelet-cli-browser-preview-home-"),
  );
  await mkdir(join(homeDir, ".forgelet", "browser"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "browser", "current-page.json"),
    JSON.stringify({
      url: "https://example.com/article",
      title: "Readable Browser Context",
      capturedAt: new Date().toISOString(),
      selectedText: "Use this selected passage for the draft.",
      mainText: "The full article should not be preferred here.",
    }),
    "utf8",
  );

  const result = await runCli(
    ["write", "--preview", "--with-browser", "turn this into an outline"],
    {
      homeDir,
      workspaceRoot,
      createLiveModelClient: async () => {
        throw new Error("model factory should not be called for preview");
      },
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Session Preview/);
  expect(result.stdout).toMatch(/Context attachments: browser: Readable Browser Context/);
  expect(result.stdout).toMatch(/Browser context:/);
  expect(result.stdout).toMatch(/URL: https:\/\/example\.com\/article/);
  expect(result.stdout).toMatch(/Title: Readable Browser Context/);
  expect(result.stdout).toMatch(/Content: selectedText/);
  expect(result.stdout).toMatch(/Content bytes: 40/);
});

test("CLI with browser context rejects stale browser snapshots", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-stale-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-stale-home-"));
  await mkdir(join(homeDir, ".forgelet", "browser"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "browser", "current-page.json"),
    JSON.stringify({
      url: "https://example.com/old",
      title: "Old Page",
      capturedAt: "2000-01-01T00:00:00.000Z",
      mainText: "This should be too old to use.",
    }),
    "utf8",
  );

  const result = await runCli(
    ["code", "--preview", "--with-browser", "use the current page"],
    { homeDir, workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/Browser snapshot is stale/);
  expect(result.stderr).toMatch(/Share the current page again/);
});

test("CLI preview succeeds for unsupported provider routes as not runnable", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-preview-route-"));

  const result = await runCli(
    ["code", "--preview", "--model", "gpt-5", "inspect this repo"],
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

test("CLI creates a Writing Project manifest", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-projects-"));

  const result = await runCli(["write", "projects", "create", "my-novel"], {
    workspaceRoot,
  });
  const manifestPath = join(
    workspaceRoot,
    ".forgelet",
    "writing",
    "projects",
    "my-novel.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Writing Project created/);
  expect(result.stdout).toMatch(/Slug: my-novel/);
  expect(result.stdout).toMatch(
    /Manifest: \.forgelet\/writing\/projects\/my-novel\.json/,
  );
  expect(manifest).toEqual({
    slug: "my-novel",
    createdAt: expect.any(String),
    head: null,
    members: [],
  });
});

test("CLI rejects duplicate Writing Project creation", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-projects-"));
  await runCli(["write", "projects", "create", "my-novel"], { workspaceRoot });

  const result = await runCli(["write", "projects", "create", "my-novel"], {
    workspaceRoot,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/Writing Project already exists: my-novel/);
});

test("CLI rejects Writing Project runs for unknown slugs and lists existing projects", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-projects-"));
  await runCli(["write", "projects", "create", "other-novel"], { workspaceRoot });

  const result = await runCli(
    ["write", "--project", "missing-novel", "write chapter one"],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/Unknown Writing Project: missing-novel/);
  expect(result.stderr).toMatch(/Existing projects: other-novel/);
});

test("CLI rejects Writing Project continuation from a non-member artifact", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-projects-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing", "projects"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-1.md"),
    "Chapter one.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "projects", "my-novel.json"),
    JSON.stringify(
      {
        slug: "my-novel",
        createdAt: "2026-07-06T00:00:00.000Z",
        head: ".forgelet/writing/chapter-1.md",
        members: [".forgelet/writing/chapter-1.md"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const result = await runCli(
    [
      "write",
      "--project",
      "my-novel",
      "--creative",
      "--style",
      "vivid",
      "--continue",
      ".forgelet/writing/not-a-member.md",
      "revise",
    ],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(
    /--continue artifact is not a member of Writing Project my-novel/,
  );
  expect(result.stderr).toMatch(/Remove --project to continue it directly/);
  expect(result.stderr).toMatch(/edit \.forgelet\/writing\/projects\/my-novel\.json/);
});

test("CLI rejects combining Writing Project runs with explicit read scope", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-projects-"));
  await runCli(["write", "projects", "create", "my-novel"], { workspaceRoot });

  const result = await runCli(
    [
      "write",
      "--project",
      "my-novel",
      "--allow-read",
      "src",
      "write chapter one",
    ],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(
    /--project cannot be combined with --allow-read/,
  );
});

test("CLI lists Writing Artifact Catalog entries without starting a Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-artifacts-list-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "rain-sess_artifact.md"),
    "Draft body\n",
    "utf8",
  );
  await writeFile(
    join(sessionDir, "sess_artifact.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-04T10:00:00.000Z",
        sessionId: "sess_artifact",
        payload: {
          workflow: "writing",
          workflowVariant: "creative",
          creativeStyle: "vivid",
          projectSlug: "my-novel",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-04T10:00:01.000Z",
        sessionId: "sess_artifact",
        payload: { task: "write rain" },
      }),
      JSON.stringify({
        type: "writing_artifact",
        ts: "2026-07-04T10:22:00.000Z",
        sessionId: "sess_artifact",
        payload: {
          path: ".forgelet/writing/rain-sess_artifact.md",
          contentKind: "draft",
          contentBytes: 11,
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const before = await readdir(sessionDir);
  const result = await runCli(["write", "artifacts", "list"], {
    workspaceRoot,
    createLiveModelClient: async () => {
      throw new Error("model factory should not be called for artifact catalog");
    },
  });
  const after = await readdir(sessionDir);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Writing Artifact Catalog/);
  expect(result.stdout).toMatch(/Path: \.forgelet\/writing/);
  expect(result.stdout).toMatch(/Artifacts: 1/);
  expect(result.stdout).toMatch(/rain-sess_artifact\.md/);
  expect(result.stdout).toMatch(/Status: available/);
  expect(result.stdout).toMatch(/Kind: draft/);
  expect(result.stdout).toMatch(/Project: my-novel/);
  expect(result.stdout).toMatch(/Session: sess_artifact/);
  expect(result.stdout).toMatch(/Task: write rain/);
  expect(result.stdout).toMatch(
    /Continue: forge write --creative --style vivid --continue \.forgelet\/writing\/rain-sess_artifact\.md "<brief>"/,
  );
  expect(after).toEqual(before);
});

test("CLI searches Writing Artifact Catalog entries without starting a Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-artifacts-search-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "rain-sess_search.md"),
    "Neon rain scene with a humming freezer.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "loose-rain.md"),
    "Loose rain vignette.\n",
    "utf8",
  );
  await utimes(
    join(workspaceRoot, ".forgelet", "writing", "loose-rain.md"),
    new Date("2026-07-04T09:00:00.000Z"),
    new Date("2026-07-04T09:00:00.000Z"),
  );
  await writeFile(
    join(sessionDir, "sess_search.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-04T10:00:00.000Z",
        sessionId: "sess_search",
        payload: {
          workflow: "writing",
          workflowVariant: "creative",
          creativeStyle: "vivid",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-04T10:00:01.000Z",
        sessionId: "sess_search",
        payload: { task: "write rain" },
      }),
      JSON.stringify({
        type: "writing_artifact",
        ts: "2026-07-04T10:22:00.000Z",
        sessionId: "sess_search",
        payload: {
          path: ".forgelet/writing/rain-sess_search.md",
          contentKind: "draft",
          contentBytes: 40,
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const before = await readdir(sessionDir);
  const result = await runCli(
    ["write", "artifacts", "search", "--limit", "1", "rain"],
    {
      workspaceRoot,
      createLiveModelClient: async () => {
        throw new Error("model factory should not be called for artifact search");
      },
    },
  );
  const noResults = await runCli(["write", "artifacts", "search", "moon"], {
    workspaceRoot,
  });
  const after = await readdir(sessionDir);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Writing Artifact Catalog Search/);
  expect(result.stdout).toMatch(/Path: \.forgelet\/writing/);
  expect(result.stdout).toMatch(/Query: rain/);
  expect(result.stdout).toMatch(/Results: 1/);
  expect(result.stdout).toMatch(/rain-sess_search\.md/);
  expect(result.stdout).toMatch(/Status: available/);
  expect(result.stdout).toMatch(/Snippet: .*rain/);
  expect(result.stdout).toMatch(
    /Continue: forge write --creative --style vivid --continue \.forgelet\/writing\/rain-sess_search\.md "<brief>"/,
  );
  expect(noResults.exitCode).toBe(0);
  expect(noResults.stdout).toMatch(/Results: 0/);
  expect(after).toEqual(before);
});

test("CLI shows Writing Artifacts by path or Session id with preview and full body", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-artifacts-show-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const body = `${"A".repeat(4_050)}\nTHE END\n`;
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "rain-sess_artifact.md"),
    body,
    "utf8",
  );
  await writeFile(
    join(sessionDir, "sess_artifact.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-04T10:00:00.000Z",
        sessionId: "sess_artifact",
        payload: {
          workflow: "writing",
          workflowVariant: "creative",
          creativeStyle: "vivid",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-04T10:00:01.000Z",
        sessionId: "sess_artifact",
        payload: { task: "write rain" },
      }),
      JSON.stringify({
        type: "writing_artifact",
        ts: "2026-07-04T10:22:00.000Z",
        sessionId: "sess_artifact",
        payload: {
          path: ".forgelet/writing/rain-sess_artifact.md",
          contentKind: "draft",
          contentBytes: Buffer.byteLength(body, "utf8"),
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const preview = await runCli(
    ["write", "artifacts", "show", ".forgelet/writing/rain-sess_artifact.md"],
    { workspaceRoot },
  );
  const full = await runCli(
    ["write", "artifacts", "show", "sess_artifact", "--full"],
    { workspaceRoot },
  );

  expect(preview.exitCode).toBe(0);
  expect(preview.stderr).toBe("");
  expect(preview.stdout).toMatch(/Writing Artifact/);
  expect(preview.stdout).toMatch(/Path: \.forgelet\/writing\/rain-sess_artifact\.md/);
  expect(preview.stdout).toMatch(/Session: sess_artifact/);
  expect(preview.stdout).toMatch(/Trace: \.forgelet\/sessions\/sess_artifact\.jsonl/);
  expect(preview.stdout).toMatch(/Preview:\nA+/);
  expect(preview.stdout).toMatch(/\[truncated\]/);
  expect(preview.stdout).not.toContain("THE END");
  expect(full.exitCode).toBe(0);
  expect(full.stdout).toContain("THE END");
  expect(full.stdout).not.toMatch(/\[truncated\]/);
});

test("CLI handles untracked, missing, and external Writing Artifact show requests", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-artifacts-show-errors-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "loose.md"),
    "Loose body\n",
    "utf8",
  );
  await writeFile(
    join(sessionDir, "sess_missing_artifact.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-04T10:00:00.000Z",
        sessionId: "sess_missing_artifact",
        payload: { workflow: "writing", workflowVariant: "creative" },
      }),
      JSON.stringify({
        type: "writing_artifact",
        ts: "2026-07-04T10:22:00.000Z",
        sessionId: "sess_missing_artifact",
        payload: {
          path: ".forgelet/writing/missing.md",
          contentKind: "draft",
          contentBytes: 99,
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const untracked = await runCli(
    ["write", "artifacts", "show", ".forgelet/writing/loose.md"],
    { workspaceRoot },
  );
  const missing = await runCli(
    ["write", "artifacts", "show", "sess_missing_artifact"],
    { workspaceRoot },
  );
  const external = await runCli(
    ["write", "artifacts", "show", "README.md"],
    { workspaceRoot },
  );

  expect(untracked.exitCode).toBe(0);
  expect(untracked.stdout).toMatch(/Status: untracked/);
  expect(untracked.stdout).toMatch(/Trace: none/);
  expect(untracked.stdout).toMatch(/Loose body/);
  expect(missing.exitCode).toBe(1);
  expect(missing.stderr).toMatch(/artifact file is missing/);
  expect(missing.stderr).toMatch(/Trace provenance still exists/);
  expect(missing.stderr).toMatch(/\.forgelet\/sessions\/sess_missing_artifact\.jsonl/);
  expect(external.exitCode).toBe(1);
  expect(external.stderr).toMatch(/only previews files under \.forgelet\/writing/);
});

test("CLI default coding run creates a model-backed Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-default-model-"));
  const modelClient = new FakeModelClient([
    { content: "Inspected the repo.", toolCalls: [] },
  ]);
  let factoryWorkflow: string | undefined;
  const liveEventTypes: string[] = [];

  const result = await runCli(["code", "inspect this repo"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async (input) => {
      factoryWorkflow = input.workflow;
      return modelClient;
    },
    onLiveEvent: async (event) => {
      liveEventTypes.push(event.type);
    },
  });

  expect(result.exitCode).toBe(0);
  expect(factoryWorkflow).toBe("coding");
  expect(result.stdout).toMatch(/Inspected the repo\./);
  expect(result.stdout).not.toMatch(/scaffold/);
  expect(modelClient.turnInputs).toHaveLength(1);
  expect(liveEventTypes).toContain("session_started");
  expect(liveEventTypes).toContain("model_turn_started");
  expect(liveEventTypes).toContain("session_finished");

  const tracePath = result.stdout.match(/Trace: (.+)$/m)?.[1];
  const events = (await readFile(tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.some((event) => event.type === "model_turn")).toBe(true);
});

test("CLI coding run with browser context attaches browser content without storing full page text in the Trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-code-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-code-home-"));
  await mkdir(join(homeDir, ".forgelet", "browser"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "browser", "current-page.json"),
    JSON.stringify({
      url: "https://github.com/acme/app/issues/42",
      title: "Checkout button fails",
      capturedAt: new Date().toISOString(),
      selectedText: "Clicking checkout raises TypeError in PaymentButton.",
      mainText: "Full issue body that should not be preferred.",
    }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Used the browser issue context.", toolCalls: [] },
  ]);

  const result = await runCli(
    ["code", "--with-browser", "implement the issue I am viewing"],
    {
      homeDir,
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => modelClient,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Browser context:/);
  expect(result.stdout).toMatch(/URL: https:\/\/github\.com\/acme\/app\/issues\/42/);
  expect(result.stdout).toMatch(/Content: selectedText/);

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "user",
  )?.content;
  expect(firstUserMessage).toMatch(/Context attachments:/);
  expect(firstUserMessage).toMatch(/source: browser/);
  expect(firstUserMessage).toMatch(/title: Checkout button fails/);
  expect(firstUserMessage).toMatch(/uri: https:\/\/github\.com\/acme\/app\/issues\/42/);
  expect(firstUserMessage).toMatch(/Clicking checkout raises TypeError/);
  expect(firstUserMessage).not.toMatch(/Full issue body/);

  const tracePath = result.stdout.match(/Trace: (.+)$/m)?.[1];
  const events = (await readFile(tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const contextEvent = events.find(
    (event) => event.type === "context_attachment",
  );
  expect(contextEvent?.payload).toMatchObject({
    source: "browser",
    title: "Checkout button fails",
    uri: "https://github.com/acme/app/issues/42",
    trustLevel: "external",
  });
  expect("content" in contextEvent.payload).toBe(false);
  expect(JSON.stringify(contextEvent.payload)).not.toMatch(/Full issue body/);
});

test("CLI default writing run creates a model-backed Writing Session", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-default-writing-model-"),
  );
  const modelClient = new FakeModelClient([
    { content: "Revision\n\nA clearer draft.", toolCalls: [] },
  ]);
  let factoryWorkflow: string | undefined;

  const result = await runCli(["write", "revise this"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async (input) => {
      factoryWorkflow = input.workflow;
      return modelClient;
    },
  });

  expect(result.exitCode).toBe(0);
  expect(factoryWorkflow).toBe("writing");
  expect(result.stdout).toMatch(/Revision/);
  expect(result.stdout).not.toMatch(/scaffold/);
  expect(modelClient.turnInputs).toHaveLength(1);

  const tracePath = result.stdout.match(/Trace: (.+)$/m)?.[1];
  const events = (await readFile(tracePath ?? "", "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    events.find((event) => event.type === "session_started")?.payload.workflow,
  ).toBe("writing");
  expect(events.some((event) => event.type === "model_turn")).toBe(true);
});

test("CLI Writing Project run can start from an empty project", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-project-run-"));
  await runCli(["write", "projects", "create", "my-novel"], { workspaceRoot });
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter one begins.", toolCalls: [] },
  ]);

  const result = await runCli(
    [
      "write",
      "--project",
      "my-novel",
      "--creative",
      "--style",
      "vivid",
      "write chapter one",
    ],
    {
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => modelClient,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Chapter one begins/);
  expect(modelClient.turnInputs).toHaveLength(1);
  const manifest = JSON.parse(
    await readFile(
      join(
        workspaceRoot,
        ".forgelet",
        "writing",
        "projects",
        "my-novel.json",
      ),
      "utf8",
    ),
  );
  const artifactPath = result.stdout.match(
    /Writing artifact: (\.forgelet\/writing\/[^ ]+)/,
  )?.[1];
  expect(manifest.members).toEqual([artifactPath]);
  expect(manifest.head).toBe(artifactPath);
});

test("CLI Writing Project run ignores missing non-head members with a warning", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-project-run-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing", "projects"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "chapter-2.md"),
    "Chapter two.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "projects", "my-novel.json"),
    JSON.stringify(
      {
        slug: "my-novel",
        createdAt: "2026-07-06T00:00:00.000Z",
        head: ".forgelet/writing/chapter-2.md",
        members: [
          ".forgelet/writing/chapter-1.md",
          ".forgelet/writing/chapter-2.md",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Draft\n\nChapter three.", toolCalls: [] },
  ]);

  const result = await runCli(
    [
      "write",
      "--project",
      "my-novel",
      "--creative",
      "--style",
      "vivid",
      "write chapter three",
    ],
    {
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => modelClient,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(
    /Warning: Writing Project member is missing and was excluded from this Session Read Scope: \.forgelet\/writing\/chapter-1\.md/,
  );
  expect(result.stdout).toMatch(/Chapter three/);
});

test("CLI writing run with browser context falls back to main page text", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-write-"));
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-browser-write-home-"));
  await mkdir(join(homeDir, ".forgelet", "browser"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "browser", "current-page.json"),
    JSON.stringify({
      url: "https://example.com/article",
      title: "How Tiny Tools Shape Writing",
      capturedAt: new Date().toISOString(),
      mainText: "Small local tools can make drafting feel lighter and more source-linked.",
    }),
    "utf8",
  );
  const modelClient = new FakeModelClient([
    { content: "Outline\n\n1. Tiny tools", toolCalls: [] },
  ]);

  const result = await runCli(
    ["write", "--with-browser", "turn this into an outline"],
    {
      homeDir,
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => modelClient,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Content: mainText/);

  const firstUserMessage = modelClient.turnInputs[0]?.messages.find(
    (message) => message.role === "user",
  )?.content;
  expect(firstUserMessage).toMatch(/source: browser/);
  expect(firstUserMessage).toMatch(/title: How Tiny Tools Shape Writing/);
  expect(firstUserMessage).toMatch(
    /Small local tools can make drafting feel lighter/,
  );
});

test("interactive terminal suppresses repeated writing stdout after final answer streamed", async () => {
  const writes: string[] = [];
  const terminalOutput = createInteractiveTerminalOutputController((text) => {
    writes.push(text);
  });

  await terminalOutput.onLiveEvent({
    type: "model_turn_started",
    turnIndex: 0,
    model: "deepseek-v4-flash",
  });
  await terminalOutput.onLiveEvent({
    type: "model_output_delta",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    text: "Revision\n\nA clearer draft.",
  });
  await terminalOutput.onLiveEvent({
    type: "model_turn_finished",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    toolCallCount: 0,
  });

  expect(terminalOutput.shouldSuppressFinalStdout(["write", "revise this"])).toBe(
    true,
  );
  expect(terminalOutput.shouldSuppressFinalStdout(["code", "inspect repo"])).toBe(
    false,
  );
  expect(
    terminalOutput.formatSuppressedFinalStdoutFooter(
      [
        "Revision",
        "",
        "A clearer draft.",
        "Writing artifact: .forgelet/writing/revise-this.md (draft, 16 bytes)",
        "Trace: /tmp/work/.forgelet/sessions/sess_123.jsonl",
      ].join("\n"),
    ),
  ).toBe(
    [
      "Writing artifact: .forgelet/writing/revise-this.md (draft, 16 bytes)",
      "Trace: /tmp/work/.forgelet/sessions/sess_123.jsonl",
    ].join("\n"),
  );
  expect(writes.join("")).toContain("A clearer draft.");
});

test("interactive terminal keeps writing stdout when streamed output was not final", async () => {
  const terminalOutput = createInteractiveTerminalOutputController(() => {});

  await terminalOutput.onLiveEvent({
    type: "model_output_delta",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    text: "I need to inspect context first.",
  });
  await terminalOutput.onLiveEvent({
    type: "model_turn_finished",
    turnIndex: 0,
    model: "deepseek-v4-flash",
    toolCallCount: 1,
  });

  expect(terminalOutput.shouldSuppressFinalStdout(["write", "revise this"])).toBe(
    false,
  );
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
    ["config", "set", "activeContext.maxConversationBytes", "65536"],
    { homeDir, workspaceRoot },
  );
  const get = await runCli(["config", "get"], { homeDir, workspaceRoot });

  expect(set.exitCode).toBe(0);
  expect(JSON.parse(get.stdout).activeContext.maxConversationBytes).toBe(65_536);
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
    /forge config set activeContext\.maxConversationBytes 65536/,
  );
  expect(result.stdout).toMatch(
    /forge config set activeContext\.observationDigestPreviewBytes 2048/,
  );
  expect(result.stdout).toMatch(/forge resume <sessionId> --act "<instruction>"/);
  expect(result.stdout).toMatch(
    /forge write --creative --style vivid --continue \.forgelet\/writing\/chapter-1\.md "continue the next chapter"/,
  );
  expect(result.stdout).toMatch(
    /Styles: plain, vivid, tight, literary, cinematic, minimal, lyrical, noir, warm, sharp, sensual, ardent/,
  );
  expect(result.stdout).toMatch(/forge write artifacts list/);
  expect(result.stdout).toMatch(/forge write artifacts show <sessionId> --full/);
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
    ["config", "set", "activeContext.maxConversationBytes", "4095"],
    { homeDir, workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(
    /activeContext\.maxConversationBytes.*at least 4096/,
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
  expect(result.stdout).toMatch(
    /Trace: .*\.forgelet\/sessions\/\d{8}_\d{6}_sess_/,
  );
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

test("CLI resume rejects Learning Workflow Sessions in the first slice", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-resume-learning-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_learning.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-03T00:00:00.000Z",
        sessionId: "sess_learning",
        payload: {
          workflow: "learning",
          startedAt: "2026-07-03T00:00:00.000Z",
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-07-03T00:00:02.000Z",
        sessionId: "sess_learning",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(["resume", "sess_learning", "expand the open questions"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () =>
      new FakeModelClient([{ content: "should not run", toolCalls: [] }]),
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Learning Workflow resume is not available yet/);
});

test("CLI records repeated --allow-read entries as the Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-read-scope-"),
  );
  await mkdir(join(workspaceRoot, "src", "workflows"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "Forgelet\n", "utf8");
  const result = await runCli(
    [
      "code",
      "--allow-read",
      "./README.md",
      "--allow-read",
      "src/workflows/",
      "inspect allowed files",
    ],
    {
      workspaceRoot,
      env: {},
      createLiveModelClient: async () =>
        new FakeModelClient([{ content: "Inspected allowed files.", toolCalls: [] }]),
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
    ["code", "--allow-read", allowedPath, "inspect allowed files"],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/--allow-read paths must be workspace-relative/);
});

test("CLI rejects bare coding input without calling a model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-bare-code-"));
  let modelFactoryCalled = false;

  const result = await runCli(["inspect repo"], {
    workspaceRoot,
    createLiveModelClient: async () => {
      modelFactoryCalled = true;
      return new FakeModelClient([{ content: "should not run", toolCalls: [] }]);
    },
  });

  expect(result.exitCode).toBe(1);
  expect(modelFactoryCalled).toBe(false);
  expect(result.stderr).toMatch(/Unknown command: inspect repo/);
});

test("CLI rejects singular session command input without calling a model", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-session-typo-"));
  let modelFactoryCalled = false;

  const result = await runCli(["session", "list"], {
    workspaceRoot,
    createLiveModelClient: async () => {
      modelFactoryCalled = true;
      return new FakeModelClient([{ content: "should not run", toolCalls: [] }]);
    },
  });

  expect(result.exitCode).toBe(1);
  expect(modelFactoryCalled).toBe(false);
  expect(result.stderr).toMatch(/Unknown command: session/);
});

test("CLI creates a project Knowledge Note from a completed Learning Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-notes-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_learn.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-03T00:00:00.000Z",
        sessionId: "sess_learn",
        payload: { workflow: "learning", startedAt: "2026-07-03T00:00:00.000Z" },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-03T00:00:00.000Z",
        sessionId: "sess_learn",
        payload: { task: "Teach Me Core Ideas" },
      }),
      JSON.stringify({
        type: "context_attachment",
        ts: "2026-07-03T00:00:00.000Z",
        sessionId: "sess_learn",
        payload: {
          id: "ctx_1",
          source: "file",
          title: "paper.md",
          uri: "paper.md",
          mimeType: "text/markdown",
          contentBytes: 128,
          contentHash: createHash("sha256").update("paper").digest("hex"),
          preview: "Paper preview",
          trustLevel: "workspace",
        },
      }),
      JSON.stringify({
        type: "final_summary",
        ts: "2026-07-03T00:00:01.000Z",
        sessionId: "sess_learn",
        payload: { summary: "## Summary\nCore ideas." },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-07-03T00:00:02.000Z",
        sessionId: "sess_learn",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(
    ["notes", "create", "--scope", "project", "--from-session", "sess_learn"],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Knowledge Note created/);
  expect(result.stdout).toMatch(
    /Path: \.forgelet\/knowledge\/teach-me-core-ideas-sess_learn\.md/,
  );
  expect(result.stdout).toMatch(/Source Session: sess_learn/);
  expect(result.stdout).toMatch(/Sources: 1/);
  expect(result.stdout).toMatch(/Content hash: [a-f0-9]{64}/);
});

test("CLI searches accepted project Knowledge Notes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-notes-search-"));
  await mkdir(join(workspaceRoot, ".forgelet", "knowledge"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "knowledge", "workflow-note.md"),
    [
      "---",
      "type: knowledge-note",
      "scope: project",
      "title: Workflow Graph Design",
      "sourceSessionId: sess_learn",
      "sourceWorkflow: learning",
      "createdAt: 2026-07-03T01:02:03.000Z",
      "contentHash: abc123",
      "sources: []",
      "---",
      "",
      "# Workflow Graph Design",
      "",
      "## Summary",
      "Workflow graph design keeps the agent path explicit.",
    ].join("\n"),
    "utf8",
  );

  const result = await runCli(
    ["notes", "search", "--scope", "project", "--limit", "5", "workflow graph"],
    { workspaceRoot },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Knowledge Notes Search/);
  expect(result.stdout).toMatch(/Scope: project/);
  expect(result.stdout).toMatch(/Path: \.forgelet\/knowledge/);
  expect(result.stdout).toMatch(/Query: workflow graph/);
  expect(result.stdout).toMatch(/Results: 1/);
  expect(result.stdout).toMatch(/1\. Workflow Graph Design/);
  expect(result.stdout).toMatch(/Source Session: sess_learn/);
  expect(result.stdout).toMatch(/Snippet: .*Workflow graph design/i);
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

  const result = await runCli(["code", "--live", "--model", "gpt-5", "inspect repo"], {
    workspaceRoot,
    env: { DEEPSEEK_API_KEY: "test-key" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Unknown option: --live/);
});

test("CLI default model-backed run explains missing DeepSeek API key", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-missing-key-"));

  const result = await runCli(["code", "inspect repo"], {
    workspaceRoot,
    env: {},
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(
    /DEEPSEEK_API_KEY is required for model-backed Sessions/,
  );
  expect(result.stderr).toMatch(/Set it in \.env/);
  expect(result.stderr).toMatch(/forge code --preview "<task>"/);
});

test("CLI default model-backed run rejects unsupported provider routes", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-unsupported-route-"),
  );

  const result = await runCli(["code", "--model", "gpt-5", "inspect repo"], {
    workspaceRoot,
    env: { DEEPSEEK_API_KEY: "test-key" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(
    /Model-backed execution currently supports DeepSeek models only/,
  );
  expect(result.stderr).toMatch(/Route selected gpt-5/);
});
