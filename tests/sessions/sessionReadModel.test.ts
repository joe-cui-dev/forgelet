import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { basename, join } from "path";
import { tmpdir } from "os";
import { listSessions } from "../../src/sessions/index.js";
import { showSession } from "../../src/sessions/index.js";
import { foldSessionTrace } from "../../src/sessions/index.js";
import { buildSessionLineage } from "../../src/sessions/continuation.js";
import { isTraceEvent, parseTraceEventLine } from "../../src/trace/index.js";
import { runWritingSession } from "../../src/workflows/writing.js";

test("folds lifecycle evidence once for downstream Session read models", () => {
  const events = [
    {
      type: "session_started",
      ts: "2026-07-17T00:00:00.000Z",
      sessionId: "sess_folded",
      payload: {
        workflow: "coding",
        startedAt: "2026-07-17T00:00:00.000Z",
        taskHash: "taskhash",
      },
    },
    {
      type: "user_task",
      ts: "2026-07-17T00:00:01.000Z",
      sessionId: "sess_folded",
      payload: { task: "consolidate lifecycle evidence" },
    },
    {
      type: "routing_selected",
      ts: "2026-07-17T00:00:02.000Z",
      sessionId: "sess_folded",
      payload: { model: "deepseek-v4-flash", reason: "configured route" },
    },
    {
      type: "final_summary",
      ts: "2026-07-17T00:00:03.000Z",
      sessionId: "sess_folded",
      payload: { summary: "Lifecycle evidence consolidated." },
    },
    {
      type: "session_paused",
      ts: "2026-07-17T00:00:04.000Z",
      sessionId: "sess_folded",
      payload: { reason: "out_of_envelope" },
    },
  ].map((event) => parseTraceEventLine(JSON.stringify(event))).filter(isTraceEvent);

  expect(foldSessionTrace(events)).toMatchObject({
    id: "sess_folded",
    workflow: "coding",
    task: "consolidate lifecycle evidence",
    taskHash: "taskhash",
    startedAt: "2026-07-17T00:00:00.000Z",
    status: "paused",
    pausedAt: "2026-07-17T00:00:04.000Z",
    finalSummary: "Lifecycle evidence consolidated.",
    route: { model: "deepseek-v4-flash", reason: "configured route" },
  });
});

function lifecycleTrace(
  steps: readonly (readonly [type: string, payload: Record<string, unknown>])[],
) {
  return [
    {
      type: "session_started",
      ts: "2026-07-18T00:00:00.000Z",
      sessionId: "sess_lifecycle",
      payload: { workflow: "coding", taskHash: "taskhash" },
    },
    ...steps.map(([type, payload], index) => ({
      type,
      ts: `2026-07-18T00:00:0${index + 1}.000Z`,
      sessionId: "sess_lifecycle",
      payload,
    })),
  ]
    .map((event) => parseTraceEventLine(JSON.stringify(event)))
    .filter(isTraceEvent);
}

test("a failed resume attempt re-arms the pause in the lifecycle fold", () => {
  const events = lifecycleTrace([
    ["session_paused", { reason: "out_of_envelope" }],
    ["session_resumed", { decision: "approve" }],
    ["session_resume_failed", { reason: "model_execution_error" }],
  ]);

  expect(foldSessionTrace(events)).toMatchObject({
    status: "paused",
    pausedAt: "2026-07-18T00:00:01.000Z",
    hasFinished: false,
  });
});

test("the last session_finished decides status for a historical retried trace", () => {
  const events = lifecycleTrace([
    ["session_paused", { reason: "out_of_envelope" }],
    ["session_resumed", { decision: "approve" }],
    ["session_finished", { status: "failed", reason: "model_execution_error" }],
    ["session_resumed", { decision: "approve" }],
    ["session_finished", { status: "completed" }],
  ]);

  expect(foldSessionTrace(events)).toMatchObject({ status: "completed" });
});

test("a historical crashed resume without retry still reads as failed", () => {
  const events = lifecycleTrace([
    ["session_paused", { reason: "out_of_envelope" }],
    ["session_resumed", { decision: "approve" }],
    ["session_finished", { status: "failed", reason: "model_execution_error" }],
  ]);

  expect(foldSessionTrace(events)).toMatchObject({ status: "failed" });
});

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
  await writeFile(
    join(sessionDir, "sess_failed.jsonl"),
    [
      JSON.stringify({ type: "session_started", ts: "2026-06-16T00:02:00.000Z", sessionId: "sess_failed", payload: { workflow: "writing", startedAt: "2026-06-16T00:02:00.000Z" } }),
      JSON.stringify({ type: "user_task", ts: "2026-06-16T00:02:00.000Z", sessionId: "sess_failed", payload: { task: "write scene" } }),
      JSON.stringify({ type: "session_finished", ts: "2026-06-16T00:02:01.000Z", sessionId: "sess_failed", payload: { status: "failed" } })
    ].join("\n"),
    "utf8"
  );

  const sessions = await listSessions(workspaceRoot);

  expect(sessions.map((session) => ({ id: session.id, workflow: session.workflow, status: session.status, task: session.task }))).toEqual([
      { id: "sess_failed", workflow: "writing", status: "failed", task: "write scene" },
      { id: "sess_incomplete", workflow: "writing", status: "incomplete", task: "" },
      { id: "sess_completed", workflow: "coding", status: "completed", task: "fix tests" }
    ]);
});

test("lists a paused session distinctly from a resumed-then-finished one", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-sessions-paused-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_paused.jsonl"),
    [
      JSON.stringify({ type: "session_started", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_paused", payload: { workflow: "coding", startedAt: "2026-06-16T00:00:00.000Z" } }),
      JSON.stringify({ type: "user_task", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_paused", payload: { task: "write docs" } }),
      JSON.stringify({ type: "session_paused", ts: "2026-06-16T00:00:01.000Z", sessionId: "sess_paused", payload: { reason: "out_of_envelope" } }),
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(sessionDir, "sess_resumed_then_done.jsonl"),
    [
      JSON.stringify({ type: "session_started", ts: "2026-06-16T00:01:00.000Z", sessionId: "sess_resumed_then_done", payload: { workflow: "coding", startedAt: "2026-06-16T00:01:00.000Z" } }),
      JSON.stringify({ type: "user_task", ts: "2026-06-16T00:01:00.000Z", sessionId: "sess_resumed_then_done", payload: { task: "write docs" } }),
      JSON.stringify({ type: "session_paused", ts: "2026-06-16T00:01:01.000Z", sessionId: "sess_resumed_then_done", payload: { reason: "out_of_envelope" } }),
      JSON.stringify({ type: "session_resumed", ts: "2026-06-16T00:01:02.000Z", sessionId: "sess_resumed_then_done", payload: { decision: "approve" } }),
      JSON.stringify({ type: "session_finished", ts: "2026-06-16T00:01:03.000Z", sessionId: "sess_resumed_then_done", payload: { status: "completed" } }),
    ].join("\n"),
    "utf8",
  );

  const sessions = await listSessions(workspaceRoot);

  expect(
    sessions.map((session) => ({ id: session.id, status: session.status })),
  ).toEqual([
    { id: "sess_resumed_then_done", status: "completed" },
    { id: "sess_paused", status: "paused" },
  ]);
});

test("marks a session running when its pid marker names a live process, incomplete otherwise", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-sessions-running-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  const runningDir = join(workspaceRoot, ".forgelet", "running");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(runningDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_live.jsonl"),
    JSON.stringify({ type: "session_started", ts: "2026-06-16T00:00:00.000Z", sessionId: "sess_live", payload: { workflow: "coding", startedAt: "2026-06-16T00:00:00.000Z" } }),
    "utf8",
  );
  await writeFile(join(runningDir, "sess_live.pid"), "4242", "utf8");
  await writeFile(
    join(sessionDir, "sess_stale.jsonl"),
    JSON.stringify({ type: "session_started", ts: "2026-06-16T00:01:00.000Z", sessionId: "sess_stale", payload: { workflow: "coding", startedAt: "2026-06-16T00:01:00.000Z" } }),
    "utf8",
  );
  await writeFile(join(runningDir, "sess_stale.pid"), "9999", "utf8");

  const sessions = await listSessions(workspaceRoot, {
    isProcessAlive: (pid) => pid === 4242,
  });

  expect(
    sessions.map((session) => ({ id: session.id, status: session.status })),
  ).toEqual([
    { id: "sess_stale", status: "incomplete" },
    { id: "sess_live", status: "running" },
  ]);
});

test("shows a session summary from its trace events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-show-"));
  await writeFile(join(workspaceRoot, "draft.md"), "Please make this clearer.", "utf8");
  const result = await runWritingSession({
    task: "revise this",
    contextFiles: ["draft.md"],
    workspaceRoot
  });

  const session = await showSession(workspaceRoot, result.session.id);

  expect(session.id).toBe(result.session.id);
  expect(basename(session.tracePath)).toMatch(
    /^\d{8}_\d{6}_sess_[a-z0-9]+\.jsonl$/,
  );
  expect(session.workflow).toBe("writing");
  expect(session.status).toBe("completed");
  expect(session.task).toBe("revise this");
  expect(session.contextAttachments.length).toBe(1);
  expect(session.contextAttachments[0]?.title).toBe("draft.md");
  expect(session.route?.model).toBe("deepseek-v4-flash");
  expect(session.finalSummary).toMatch(/deterministic test seam/);
});

test("shows a timestamp-prefixed session trace by Session id", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-prefixed-show-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "20260706_123945_sess_prefixed.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-07-06T02:39:45.000Z",
        sessionId: "sess_prefixed",
        payload: {
          workflow: "coding",
          startedAt: "2026-07-06T02:39:45.000Z",
        },
      }),
      JSON.stringify({
        type: "user_task",
        ts: "2026-07-06T02:39:45.000Z",
        sessionId: "sess_prefixed",
        payload: { task: "inspect repo" },
      }),
    ].join("\n"),
    "utf8",
  );

  const session = await showSession(workspaceRoot, "sess_prefixed");

  expect(session.id).toBe("sess_prefixed");
  expect(session.task).toBe("inspect repo");
  expect(basename(session.tracePath)).toBe(
    "20260706_123945_sess_prefixed.jsonl",
  );
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

test("builds a one-node Session Lineage from a completed Session", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-lineage-"));
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
        payload: { task: "fix lineage" },
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

  const lineage = await buildSessionLineage(workspaceRoot, "sess_parent");

  expect(lineage.sessionIds).toEqual(["sess_parent"]);
  expect(lineage.rootSessionId).toBe("sess_parent");
  expect(lineage.sourceSessionId).toBe("sess_parent");
  expect(lineage.degraded).toBe(false);
  expect(lineage.incompleteReasons).toEqual([]);
  expect(lineage.sourceStatus).toBe("completed");
});

test("builds a parent-to-child Session Lineage from continuation metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-lineage-child-"));
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
        type: "session_finished",
        ts: "2026-06-20T00:00:02.000Z",
        sessionId: "sess_parent",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(sessionDir, "sess_child.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:01:00.000Z",
        sessionId: "sess_child",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:01:00.000Z",
          continuation: {
            sourceSessionId: "sess_parent",
            rootSessionId: "sess_parent",
            lineageSessionIds: ["sess_parent"],
            degraded: false,
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:01:02.000Z",
        sessionId: "sess_child",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const lineage = await buildSessionLineage(workspaceRoot, "sess_child");

  expect(lineage.sessionIds).toEqual(["sess_parent", "sess_child"]);
  expect(lineage.rootSessionId).toBe("sess_parent");
  expect(lineage.sourceSessionId).toBe("sess_child");
  expect(lineage.degraded).toBe(false);
});

test("marks Session Lineage degraded when an ancestor trace is missing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-lineage-missing-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_child.jsonl"),
    [
      JSON.stringify({
        type: "session_started",
        ts: "2026-06-20T00:01:00.000Z",
        sessionId: "sess_child",
        payload: {
          workflow: "coding",
          startedAt: "2026-06-20T00:01:00.000Z",
          continuation: {
            sourceSessionId: "sess_missing",
            rootSessionId: "sess_missing",
            lineageSessionIds: ["sess_missing"],
            degraded: false,
          },
        },
      }),
      JSON.stringify({
        type: "session_finished",
        ts: "2026-06-20T00:01:02.000Z",
        sessionId: "sess_child",
        payload: { status: "completed" },
      }),
    ].join("\n"),
    "utf8",
  );

  const lineage = await buildSessionLineage(workspaceRoot, "sess_child");

  expect(lineage.sessionIds).toEqual(["sess_missing", "sess_child"]);
  expect(lineage.degraded).toBe(true);
  expect(lineage.incompleteReasons).toEqual([
    "Ancestor Session trace is missing or unreadable: sess_missing",
  ]);
});
