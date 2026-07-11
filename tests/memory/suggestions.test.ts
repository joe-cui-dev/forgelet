import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestMemoryFromSession } from "../../src/memory/index.js";
import { acceptMemorySuggestion, rejectMemorySuggestion } from "../../src/memoryReview/decide.js";
import { listMemoryReview, showMemoryReview } from "../../src/memoryReview/index.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  return workspaceRoot;
}

async function writeActionableTrace(
  workspaceRoot: string,
  sessionId: string,
  input: { changedFiles?: string[]; commands?: string[] } = {},
): Promise<void> {
  const trace = [
    {
      type: "session_started",
      ts: "2026-07-11T10:00:00.000Z",
      sessionId,
      payload: { workflow: "coding", startedAt: "2026-07-11T10:00:00.000Z" },
    },
    {
      type: "final_summary",
      ts: "2026-07-11T10:01:00.000Z",
      sessionId,
      payload: {
        audit: {
          changeGroups: {
            forgeletChanged: input.changedFiles ?? ["src/greeting.ts"],
            preExistingAtSessionStart: [],
            otherCurrentWorkspaceChanges: [],
          },
          verificationCommands: (input.commands ?? ["npm test"]).map((command) => ({
            command,
            exitCode: 0,
            timedOut: false,
          })),
          kernelObservedRisks: [],
          modelTurns: 1,
          estimatedCostUsd: 0.01,
          tracePath: `.forgelet/sessions/${sessionId}.jsonl`,
        },
      },
    },
    {
      type: "session_finished",
      ts: "2026-07-11T10:02:00.000Z",
      sessionId,
      payload: { status: "completed" },
    },
  ];
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`),
    trace.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

test("suggest appends a versioned immutable proposal with bounded provenance", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-new-");
  const changedFiles = Array.from({ length: 21 }, (_, index) =>
    index === 0 ? `src/${"x".repeat(210)}.ts` : `src/file-${index}.ts`,
  );
  const commands = Array.from({ length: 11 }, (_, index) =>
    index === 0 ? `npm run ${"v".repeat(210)}` : `npm run verify-${index}`,
  );
  await writeActionableTrace(workspaceRoot, "sess_new", { changedFiles, commands });

  const result = await suggestMemoryFromSession(workspaceRoot, "sess_new", {
    now: () => new Date("2026-07-11T10:03:00.000Z"),
  });

  expect(result.outcome).toBe("created");
  expect(result.state).toBe("proposed");
  expect(result.suggestion).toMatchObject({
    schemaVersion: 1,
    id: "mem_3b994be9a82f",
    sourceSessionId: "sess_new",
    createdAt: "2026-07-11T10:03:00.000Z",
    provenance: {
      derivation: {
        changedFiles: { total: 21 },
        successfulVerificationCommands: { total: 11 },
      },
      session: {
        workflow: "coding",
        status: "completed",
        startedAt: "2026-07-11T10:00:00.000Z",
        finishedAt: "2026-07-11T10:02:00.000Z",
      },
    },
  });
  expect(result.suggestion).not.toHaveProperty("status");
  const provenance = result.suggestion.provenance;
  if (!provenance) throw new Error("new versioned suggestion must include provenance");
  expect(provenance.derivation.changedFiles.items).toHaveLength(20);
  expect(provenance.derivation.successfulVerificationCommands.items).toHaveLength(10);
  expect(provenance.derivation.changedFiles.items[0]).toBe(`src/${"x".repeat(193)}...`);
  expect(provenance.derivation.successfulVerificationCommands.items[0]).toBe(`npm run ${"v".repeat(189)}...`);

  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_new.jsonl"),
    "utf8",
  );
  expect(provenance.trace).toEqual({
    path: ".forgelet/sessions/sess_new.jsonl",
    sha256: createHash("sha256").update(trace).digest("hex"),
    bytes: Buffer.byteLength(trace),
  });
});

test("suggest deduplicates a legacy proposal and preserves its canonical id", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-legacy-");
  await writeActionableTrace(workspaceRoot, "sess_legacy");
  const text = "In this workspace, after changing src/greeting.ts, use npm test as verification.";
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    `${JSON.stringify({
      id: "mem_timestamp",
      sourceSessionId: "sess_legacy",
      text,
      reason: "Derived deterministically from actionable Session audit evidence.",
      status: "accepted",
    })}\n`,
    "utf8",
  );

  const result = await suggestMemoryFromSession(workspaceRoot, "sess_legacy");

  expect(result).toMatchObject({
    outcome: "existing",
    state: "accepted-unwritten",
    suggestion: { id: "mem_timestamp" },
  });
  const suggestions = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(suggestions.trim().split("\n")).toHaveLength(1);
});

test("suggest deduplicates versioned proposals in every derived decision state", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-states-");
  await writeActionableTrace(workspaceRoot, "sess_states");

  const proposed = await suggestMemoryFromSession(workspaceRoot, "sess_states");
  await expect(suggestMemoryFromSession(workspaceRoot, "sess_states")).resolves.toMatchObject({
    outcome: "existing",
    state: "proposed",
    suggestion: { id: proposed.suggestion.id },
  });

  await acceptMemorySuggestion(workspaceRoot, proposed.suggestion.id);
  await expect(suggestMemoryFromSession(workspaceRoot, "sess_states")).resolves.toMatchObject({
    outcome: "existing",
    state: "accepted",
    suggestion: { id: proposed.suggestion.id },
  });

  await writeActionableTrace(workspaceRoot, "sess_rejected", {
    changedFiles: ["src/rejected.ts"],
  });
  const rejected = await suggestMemoryFromSession(workspaceRoot, "sess_rejected");
  await rejectMemorySuggestion(workspaceRoot, rejected.suggestion.id);
  await expect(suggestMemoryFromSession(workspaceRoot, "sess_rejected")).resolves.toMatchObject({
    outcome: "existing",
    state: "rejected",
    suggestion: { id: rejected.suggestion.id },
  });
});

test("suggest validates decision evidence before appending a proposal", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-corrupt-");
  await writeActionableTrace(workspaceRoot, "sess_corrupt");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    `${JSON.stringify({ type: "decision", suggestionId: "mem_broken" })}\n`,
    "utf8",
  );

  await expect(suggestMemoryFromSession(workspaceRoot, "sess_corrupt")).rejects.toThrow(
    /\.forgelet\/memory-decisions\.jsonl at line 1/,
  );
});

test("a newly suggested proposal is immediately reviewable and decidable", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-review-");
  await writeActionableTrace(workspaceRoot, "sess_review");

  const created = await suggestMemoryFromSession(workspaceRoot, "sess_review");
  const listed = await listMemoryReview(workspaceRoot, { all: false });
  const shown = await showMemoryReview(workspaceRoot, created.suggestion.id);
  const accepted = await acceptMemorySuggestion(workspaceRoot, created.suggestion.id);

  expect(listed.items).toEqual([
    expect.objectContaining({ id: created.suggestion.id, state: "proposed" }),
  ]);
  expect(shown).toMatchObject({ kind: "suggestion", state: "proposed" });
  expect(accepted).toMatchObject({ action: "accepted", outcome: "decided" });

  await writeActionableTrace(workspaceRoot, "sess_reject", {
    changedFiles: ["src/other.ts"],
  });
  const rejectedSuggestion = await suggestMemoryFromSession(workspaceRoot, "sess_reject");
  await expect(rejectMemorySuggestion(workspaceRoot, rejectedSuggestion.suggestion.id)).resolves.toMatchObject({
    action: "rejected",
    outcome: "decided",
  });
});
