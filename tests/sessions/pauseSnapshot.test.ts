import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    working: {
      ...testSnapshot().working,
      sessionState: {
        baselineDirtyPaths: new Set(["a.txt"]),
        continuationOwnedDirtyPaths: new Set(["b.txt"]),
        forgeletTouchedPaths: new Set(["c.txt", "d.txt"]),
      },
    },
  });

  await writePauseSnapshot(workspaceRoot, snapshot);
  const serialized = JSON.parse(
    await readFile(pauseSnapshotPath(workspaceRoot, snapshot.sessionId), "utf8"),
  );
  const loaded = await readPauseSnapshot(workspaceRoot, "sess_abc123");

  expect(serialized.version).toBe(4);
  expect(serialized.working.sessionState.baselineDirtyPaths).toEqual(["a.txt"]);
  expect(loaded.working.sessionState.baselineDirtyPaths).toEqual(new Set(["a.txt"]));
  expect(loaded.working.sessionState.continuationOwnedDirtyPaths).toEqual(new Set(["b.txt"]));
  expect(loaded.working.sessionState.forgeletTouchedPaths).toEqual(new Set(["c.txt", "d.txt"]));
  expect(loaded).toEqual(snapshot);
});

test("PauseSnapshot round-trips without an optional continuationOwnedDirtyPaths set", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({ sessionId: "sess_no_continuation" });

  await writePauseSnapshot(workspaceRoot, snapshot);
  const loaded = await readPauseSnapshot(workspaceRoot, "sess_no_continuation");

  expect(loaded.working.sessionState.continuationOwnedDirtyPaths).toBeUndefined();
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
  const path = pauseSnapshotPath(workspaceRoot, "sess_old_version");
  await mkdir(join(workspaceRoot, ".forgelet", "sessions", "paused"), {
    recursive: true,
  });
  await writeFile(path, JSON.stringify({ version: 999, sessionId: "sess_old_version" }), "utf8");

  await expect(readPauseSnapshot(workspaceRoot, "sess_old_version")).rejects.toThrow(
    /version/i,
  );
});

test("readPauseSnapshot tolerates a retired token limit and initializes unpriced turns", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({ sessionId: "sess_legacy_budget" });
  await writePauseSnapshot(workspaceRoot, snapshot);
  const path = pauseSnapshotPath(workspaceRoot, snapshot.sessionId);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.working.usage = { ...legacy.working.usage };
  legacy.limits = { ...legacy.limits, maxInputTokens: 100_000 };
  delete legacy.working.usage.unpricedTurns;
  await writeFile(path, JSON.stringify(legacy), "utf8");

  const loaded = await readPauseSnapshot(workspaceRoot, snapshot.sessionId);

  expect(loaded.working.usage.unpricedTurns).toBe(0);
  expect(loaded.limits).not.toHaveProperty("maxInputTokens");
});

test("readPauseSnapshot upgrades version two ledger ranges through the active-context migration", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({
    sessionId: "sess_legacy_ranges",
    working: {
      ...testSnapshot().working,
      activeContext: {
        failedFoldAttempts: 0,
        rollingSummary: {
          text: "Earlier work.",
          ledger: {
            files: [
              {
                path: "src/index.ts",
                ranges: [{ kind: "byte", start: 0, end: 20, total: 20 }],
              },
            ],
            changedFiles: [],
            commands: [],
          },
        },
      },
    },
  });
  await writePauseSnapshot(workspaceRoot, snapshot);
  const path = pauseSnapshotPath(workspaceRoot, snapshot.sessionId);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.version = 2;
  legacy.working.rollingSummary = legacy.working.activeContext.rollingSummary;
  legacy.working.failedFoldAttempts =
    legacy.working.activeContext.failedFoldAttempts;
  delete legacy.working.activeContext;
  legacy.working.rollingSummary.ledger.files[0].ranges = [
    "byte range 0-20 of 20",
  ];
  await writeFile(path, JSON.stringify(legacy), "utf8");

  const loaded = await readPauseSnapshot(workspaceRoot, snapshot.sessionId);

  expect(
    loaded.working.activeContext.rollingSummary?.ledger.files[0]?.ranges,
  ).toEqual([{ kind: "byte", start: 0, end: 20, total: 20 }]);
});

test("readPauseSnapshot migrates flat version three active context", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({ sessionId: "sess_v3_active_context" });
  await writePauseSnapshot(workspaceRoot, snapshot);
  const path = pauseSnapshotPath(workspaceRoot, snapshot.sessionId);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.version = 3;
  legacy.working.rollingSummary = {
    text: "Earlier work.",
    ledger: { files: [], changedFiles: [], commands: [] },
  };
  legacy.working.failedFoldAttempts = 1;
  delete legacy.working.activeContext;
  await writeFile(path, JSON.stringify(legacy), "utf8");

  const loaded = await readPauseSnapshot(workspaceRoot, snapshot.sessionId);

  expect(loaded.working.activeContext).toEqual({
    rollingSummary: legacy.working.rollingSummary,
    failedFoldAttempts: 1,
  });
});

test("readPauseSnapshot initializes missing version three fold attempts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-pause-"));
  const snapshot = testSnapshot({ sessionId: "sess_v3_without_summary" });
  await writePauseSnapshot(workspaceRoot, snapshot);
  const path = pauseSnapshotPath(workspaceRoot, snapshot.sessionId);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  legacy.version = 3;
  delete legacy.working.activeContext;
  await writeFile(path, JSON.stringify(legacy), "utf8");

  const loaded = await readPauseSnapshot(workspaceRoot, snapshot.sessionId);

  expect(loaded.working.activeContext).toEqual({ failedFoldAttempts: 0 });
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
    limits: {
      maxModelTurns: 12,
      maxEstimatedCostUsd: 1,
      maxWallClockMs: 1_800_000,
    },
    debug: false,
    working: {
      conversation: [{ role: "user", content: "fix the bug" }],
      activeContext: { failedFoldAttempts: 0 },
      usage: {
        modelTurns: 2,
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUsd: 0.01,
        unpricedTurns: 0,
      },
      activeWallClockMs: 1234,
      turnIndex: 2,
      audit: { changedFiles: ["src/app.ts"], commands: [{ command: "npm test", exitCode: 0, timedOut: false }] },
      sessionState: {
        baselineDirtyPaths: new Set(),
        forgeletTouchedPaths: new Set(["src/app.ts"]),
      },
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
    },
    tracePath: "/workspace/.forgelet/sessions/20260101_000000_sess_test.jsonl",
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
