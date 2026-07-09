import { expect, test } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deletePauseSnapshot,
  pauseSnapshotPath,
  readPauseSnapshot,
  writePauseSnapshot,
} from "../../src/sessions/pauseSnapshot.js";
import type { PauseSnapshot } from "../../src/sessions/pauseSnapshot.js";

test("PauseSnapshot round-trips through write and read, including Sets", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({
    sessionId: "sess_abc123",
    sessionState: {
      baselineDirtyPaths: new Set(["a.txt"]),
      continuationOwnedDirtyPaths: new Set(["b.txt"]),
      forgeletTouchedPaths: new Set(["c.txt", "d.txt"]),
    },
  });

  await writePauseSnapshot(workspaceRoot, snapshot);
  const loaded = await readPauseSnapshot(workspaceRoot, "sess_abc123");

  expect(loaded.sessionState.baselineDirtyPaths).toEqual(new Set(["a.txt"]));
  expect(loaded.sessionState.continuationOwnedDirtyPaths).toEqual(new Set(["b.txt"]));
  expect(loaded.sessionState.forgeletTouchedPaths).toEqual(new Set(["c.txt", "d.txt"]));
  expect(loaded).toEqual(snapshot);
});

test("PauseSnapshot round-trips without an optional continuationOwnedDirtyPaths set", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({ sessionId: "sess_no_continuation" });

  await writePauseSnapshot(workspaceRoot, snapshot);
  const loaded = await readPauseSnapshot(workspaceRoot, "sess_no_continuation");

  expect(loaded.sessionState.continuationOwnedDirtyPaths).toBeUndefined();
  expect(loaded).toEqual(snapshot);
});

test("deletePauseSnapshot removes the snapshot file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({ sessionId: "sess_to_delete" });
  await writePauseSnapshot(workspaceRoot, snapshot);

  await deletePauseSnapshot(workspaceRoot, "sess_to_delete");

  await expect(readPauseSnapshot(workspaceRoot, "sess_to_delete")).rejects.toThrow();
});

test("deletePauseSnapshot on a missing snapshot does not throw", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));

  await expect(deletePauseSnapshot(workspaceRoot, "sess_never_existed")).resolves.toBeUndefined();
});

test("readPauseSnapshot throws an explicit error for a missing snapshot", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));

  await expect(readPauseSnapshot(workspaceRoot, "sess_missing")).rejects.toThrow(
    /sess_missing/,
  );
});

test("readPauseSnapshot throws an explicit error for a wrong-version snapshot", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  const path = pauseSnapshotPath(workspaceRoot, "sess_old_version");
  await mkdir(join(workspaceRoot, ".forgelet", "sessions", "paused"), {
    recursive: true,
  });
  await writeFile(path, JSON.stringify({ version: 999, sessionId: "sess_old_version" }), "utf8");

  await expect(readPauseSnapshot(workspaceRoot, "sess_old_version")).rejects.toThrow(
    /version/i,
  );
});

function testSnapshot(overrides: Partial<PauseSnapshot> = {}): PauseSnapshot {
  return {
    sessionId: "sess_test",
    workflow: "coding",
    task: "fix the bug",
    taskHash: "abcd1234",
    createdAt: "2026-01-01T00:00:00.000Z",
    envelope: { writeScopePrefixes: ["src"], allowedCommands: ["npm test"] },
    route: { workflow: "coding", stage: "act_loop", model: "deepseek-chat", reason: "default" },
    plan: { items: [{ step: "Do the thing", status: "in_progress" }] },
    conversation: [{ role: "user", content: "fix the bug" }],
    failedFoldAttempts: 0,
    usage: { modelTurns: 2, inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.01 },
    activeWallClockMs: 1234,
    limits: {
      maxModelTurns: 12,
      maxInputTokens: 100_000,
      maxEstimatedCostUsd: 1,
      maxWallClockMs: 1_800_000,
    },
    turnIndex: 2,
    audit: { changedFiles: ["src/app.ts"], commands: [{ command: "npm test", exitCode: 0, timedOut: false }] },
    sessionState: {
      baselineDirtyPaths: new Set(),
      forgeletTouchedPaths: new Set(["src/app.ts"]),
    },
    debug: false,
    pendingToolCall: { id: "call_1", name: "apply_patch", input: { patch: "diff" } },
    pendingToolRequest: {
      workflow: "coding",
      toolName: "apply_patch",
      capability: "write_workspace",
      riskTier: "medium",
      input: { patch: "diff" },
      workspaceRoot: "/workspace",
      targets: [{ kind: "path", path: "docs/notes.md", classification: "ordinary" }],
    },
    remainingToolCalls: [],
    executedObservations: [],
    tracePath: "/workspace/.forgelet/sessions/20260101_000000_sess_test.jsonl",
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
