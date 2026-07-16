import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { explainSession } from "../../src/explain/index.js";

test("explains aggregate conversation compaction evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-explain-compact-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_compact.jsonl"),
    [
      event("session_started", { workflow: "coding" }),
      event("user_task", { task: "inspect files" }),
      event("conversation_compacted", {
        compactedCount: 2,
        beforeConversationBytes: 20_000,
        afterConversationBytes: 8_000,
        residualOverageBytes: 0,
      }),
      event("conversation_compaction_attempted", {
        compactedCount: 0,
        beforeConversationBytes: 9_000,
        afterConversationBytes: 9_000,
        residualOverageBytes: 1_000,
      }),
      event("conversation_compacted", {
        compactedCount: 1,
        beforeConversationBytes: 15_000,
        afterConversationBytes: 7_000,
        residualOverageBytes: 500,
      }),
      event("session_finished", { status: "completed" }),
    ].join("\n"),
    "utf8",
  );

  const explanation = await explainSession(workspaceRoot, "sess_compact");

  expect(explanation.compaction).toEqual({
    passCount: 3,
    compactedObservations: 3,
    bytesRemoved: 20_000,
    maxResidualOverageBytes: 1_000,
  });
});

test("explains a trace that retains retired input-token budget evidence", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-explain-legacy-budget-"));
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "sess_compact.jsonl"),
    [
      event("session_started", { workflow: "coding" }),
      event("user_task", { task: "inspect legacy budget evidence" }),
      event("model_turn", { turnIndex: 0 }),
      event("budget_update", {
        usage: {
          modelTurns: 1,
          inputTokens: 120_001,
          outputTokens: 10,
          estimatedCostUsd: 0.01,
        },
        limits: {
          maxModelTurns: 12,
          maxInputTokens: 120_000,
          maxEstimatedCostUsd: 1,
          maxWallClockMs: 1_800_000,
        },
      }),
      event("session_finished", {
        status: "stopped",
        reason: "input_token_limit_exceeded",
      }),
    ].join("\n"),
    "utf8",
  );

  const explanation = await explainSession(workspaceRoot, "sess_compact");

  expect(explanation).toMatchObject({
    status: "stopped",
    task: "inspect legacy budget evidence",
    modelTurns: 1,
  });
});

function event(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    type,
    ts: "2026-06-24T00:00:00.000Z",
    sessionId: "sess_compact",
    payload,
  });
}
