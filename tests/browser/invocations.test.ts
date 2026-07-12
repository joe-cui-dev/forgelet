import { expect, test } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimInvocation,
  recordInvocationOutcome,
  pruneInvocationReceipts,
} from "../../src/browser/invocations.js";

async function makeHomeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-invocations-home-"));
}

test("claiming a new invocation identity succeeds exactly once", async () => {
  const homeDir = await makeHomeDir();

  const first = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });

  expect(first.outcome).toBe("claimed");
});

test("re-claiming the same identity with the same payload replays instead of starting a second Session", async () => {
  const homeDir = await makeHomeDir();
  await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });
  await recordInvocationOutcome({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    state: "completed",
    sessionId: "sess_1",
    tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
    summary: "Forgelet session completed: sess_1",
  });

  const second = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });

  expect(second.outcome).toBe("replay");
  if (second.outcome !== "replay") throw new Error("unreachable");
  expect(second.receipt).toMatchObject({
    state: "completed",
    sessionId: "sess_1",
    tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
    summary: "Forgelet session completed: sess_1",
  });
});

test("claiming the same identity with a different payload returns a conflict", async () => {
  const homeDir = await makeHomeDir();
  await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });

  const conflicting = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_b",
  });

  expect(conflicting.outcome).toBe("conflict");
});

test("the receipt store contains no page body, only IDs, payload hash, state, and Session/Trace handles", async () => {
  const homeDir = await makeHomeDir();
  await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });
  await recordInvocationOutcome({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    state: "completed",
    sessionId: "sess_1",
    tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
    summary: "Forgelet session completed: sess_1",
  });

  const replay = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });
  if (replay.outcome !== "replay") throw new Error("unreachable");
  expect(Object.keys(replay.receipt).sort()).toEqual(
    [
      "actionId",
      "createdAt",
      "invocationId",
      "payloadHash",
      "sessionId",
      "state",
      "summary",
      "tracePath",
      "updatedAt",
    ].sort(),
  );
});

test("claiming survives process restart because the receipt is host-local file state, not an in-memory port", async () => {
  const homeDir = await makeHomeDir();
  await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });
  await recordInvocationOutcome({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    state: "completed",
    sessionId: "sess_1",
    tracePath: "/tmp/work/.forgelet/sessions/sess_1.jsonl",
    summary: "done",
  });

  // Simulate a fresh Native Host process: a brand-new call with no shared
  // in-memory state, only the same homeDir on disk.
  const afterRestart = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_1",
    payloadHash: "hash_a",
  });

  expect(afterRestart.outcome).toBe("replay");
});

test("pruneInvocationReceipts deterministically removes receipts older than the retention bound", async () => {
  const homeDir = await makeHomeDir();
  const old = new Date("2026-01-01T00:00:00.000Z");
  const recent = new Date("2026-01-10T00:00:00.000Z");
  await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_old",
    payloadHash: "hash_a",
    now: old,
  });
  await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_recent",
    payloadHash: "hash_a",
    now: recent,
  });

  const removed = await pruneInvocationReceipts({
    homeDir,
    now: new Date("2026-01-10T00:00:00.000Z"),
    maxAgeMs: 24 * 60 * 60 * 1000,
  });

  expect(removed).toBe(1);

  const oldReclaim = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_old",
    payloadHash: "hash_a",
  });
  expect(oldReclaim.outcome).toBe("claimed");

  const recentReclaim = await claimInvocation({
    homeDir,
    actionId: "summarizeCurrentPage",
    invocationId: "inv_recent",
    payloadHash: "hash_a",
  });
  expect(recentReclaim.outcome).toBe("replay");
});
