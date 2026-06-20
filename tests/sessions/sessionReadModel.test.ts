import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSessions } from "../../src/sessions/index.js";
import { showSession } from "../../src/sessions/index.js";
import { runAgent } from "../../src/agent/runAgent.js";

test("lists completed and incomplete project sessions from traces", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-sessions-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_completed.jsonl"),
    [
      JSON.stringify({ type: "session_started", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_completed", payload: { workflow: "coding", startedAt: "2026-06-16T00:00:00.000Z" } }),
      JSON.stringify({ type: "user_task", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_completed", payload: { task: "fix tests" } }),
      JSON.stringify({ type: "session_finished", ts: "2026-06-16T00:00:01.000Z", sessionId: "sess_completed", payload: { status: "completed" } })
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(sessionDir, "sess_incomplete.jsonl"),
    JSON.stringify({ type: "session_started", ts: "2026-06-16T00:01:00.000Z", sessionId: "sess_incomplete", payload: { workflow: "writing", startedAt: "2026-06-16T00:01:00.000Z" } }),
    "utf8"
  );

  const sessions = await listSessions(workspaceRoot);

  expect(sessions.map((session) => ({ id: session.id, workflow: session.workflow, status: session.status, task: session.task }))).toEqual([
      { id: "sess_incomplete", workflow: "writing", status: "incomplete", task: "" },
      { id: "sess_completed", workflow: "coding", status: "completed", task: "fix tests" }
    ]);
});

test("shows a session summary from its trace events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-show-"));
  await writeFile(join(workspaceRoot, "draft.md"), "Please make this clearer.", "utf8");
  const result = await runAgent({
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    workspaceRoot
  });

  const session = await showSession(workspaceRoot, result.session.id);

  expect(session.id).toBe(result.session.id);
  expect(session.workflow).toBe("writing");
  expect(session.status).toBe("completed");
  expect(session.task).toBe("revise this");
  expect(session.contextAttachments.length).toBe(1);
  expect(session.contextAttachments[0]?.title).toBe("draft.md");
  expect(session.route?.model).toBe("deepseek-v4-flash");
  expect(session.finalSummary).toMatch(/no model turn was run/);
});

test("shows structured final audit facts from an actionable session trace", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-show-audit-"));
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
              {
                kind: "other_workspace_changes",
                message:
                  "Workspace has current changes not attributed to Forgelet.",
                paths: ["package.json"],
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

  const session = await showSession(workspaceRoot, "sess_audit");

  expect(session.audit).toEqual({
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
      {
        kind: "other_workspace_changes",
        message: "Workspace has current changes not attributed to Forgelet.",
        paths: ["package.json"],
      },
    ],
    modelTurns: 4,
    estimatedCostUsd: 0.0123,
    tracePath: ".forgelet/sessions/sess_audit.jsonl",
  });
});
