import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSuggestionRecords,
  readDecisionLogRecords,
} from "../../src/memoryReview/records.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  return workspaceRoot;
}

async function writeSuggestions(
  workspaceRoot: string,
  lines: string[],
): Promise<void> {
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    lines.join("\n") + "\n",
    "utf8",
  );
}

async function writeDecisions(
  workspaceRoot: string,
  lines: string[],
): Promise<void> {
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    lines.join("\n") + "\n",
    "utf8",
  );
}

test("a missing suggestions file reads as an empty list", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-missing-");
  await expect(readSuggestionRecords(workspaceRoot)).resolves.toEqual([]);
});

test("legacy v0 and versioned v1 suggestion records parse in append order", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-parse-");
  const sourceSessionId = "sess_b";
  const text = "Versioned guidance.";
  const id = `mem_${createHash("sha256")
    .update(`${sourceSessionId}\n${text}`)
    .digest("hex")
    .slice(0, 12)}`;
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({
      id: "mem_legacy1",
      sourceSessionId: "sess_a",
      text: "Legacy guidance.",
      reason: "Derived deterministically.",
      status: "accepted",
    }),
    JSON.stringify({
      schemaVersion: 1,
      id,
      sourceSessionId,
      text,
      createdAt: "2026-07-10T09:00:00Z",
      provenance: {
        derivation: {
          changedFiles: { items: [], total: 0 },
          successfulVerificationCommands: { items: [], total: 0 },
        },
        trace: { path: ".forgelet/sessions/sess_b.jsonl", sha256: "0".repeat(64), bytes: 0 },
        session: {
          workflow: "coding",
          status: "completed",
          startedAt: "2026-07-10T09:00:00Z",
          finishedAt: "2026-07-10T09:00:00Z",
        },
      },
    }),
  ]);

  const records = await readSuggestionRecords(workspaceRoot);
  expect(records).toHaveLength(2);
  expect(records[0]).toMatchObject({
    id: "mem_legacy1",
    sourceSessionId: "sess_a",
    text: "Legacy guidance.",
    legacyStatus: "accepted",
  });
  expect(records[0]?.createdAt).toBeUndefined();
  expect(records[1]).toMatchObject({
    id,
    sourceSessionId: "sess_b",
    text: "Versioned guidance.",
    createdAt: "2026-07-10T09:00:00Z",
  });
  expect(records[1]?.legacyStatus).toBeUndefined();
});

test("malformed JSON fails naming the suggestions file and line", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-badjson-");
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({
      id: "mem_ok",
      sourceSessionId: "sess_a",
      text: "Fine.",
      reason: "Fine.",
      status: "proposed",
    }),
    "{not json",
  ]);

  await expect(readSuggestionRecords(workspaceRoot)).rejects.toThrow(
    /\.forgelet\/memory-suggestions\.jsonl.*line 2/,
  );
});

test("an invalid legacy record fails naming the file and line", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-badlegacy-");
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({ id: "mem_broken", sourceSessionId: "sess_a", status: "proposed" }),
  ]);

  await expect(readSuggestionRecords(workspaceRoot)).rejects.toThrow(
    /\.forgelet\/memory-suggestions\.jsonl.*line 1/,
  );
});

test("an invalid versioned record fails naming the file and line", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-badv1-");
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({
      schemaVersion: 1,
      id: "mem_abcdef012345",
      sourceSessionId: "sess_b",
      text: "No createdAt.",
    }),
  ]);

  await expect(readSuggestionRecords(workspaceRoot)).rejects.toThrow(
    /\.forgelet\/memory-suggestions\.jsonl.*line 1/,
  );
});

test("versioned records reject stored state and incomplete immutable evidence", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-invalid-evidence-");
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({
      schemaVersion: 1,
      id: "mem_abcdef012345",
      sourceSessionId: "sess_b",
      text: "Bad evidence.",
      createdAt: "2026-07-10T09:00:00Z",
      status: "proposed",
    }),
  ]);

  await expect(readSuggestionRecords(workspaceRoot)).rejects.toThrow(
    /versioned records must not store status.*\.forgelet\/memory-suggestions\.jsonl at line 1/,
  );
});

test("versioned records reject impossible ISO-looking UTC dates", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-invalid-date-");
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({
      schemaVersion: 1,
      id: "mem_abcdef012345",
      sourceSessionId: "sess_b",
      text: "Bad date.",
      createdAt: "2026-02-29T00:00:00Z",
    }),
  ]);

  await expect(readSuggestionRecords(workspaceRoot)).rejects.toThrow(
    /createdAt must be ISO-8601 UTC.*\.forgelet\/memory-suggestions\.jsonl at line 1/,
  );
});

test("an unknown schema version fails naming the file and line", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-badver-");
  await writeSuggestions(workspaceRoot, [
    JSON.stringify({
      schemaVersion: 9,
      id: "mem_future",
      sourceSessionId: "sess_b",
      text: "From the future.",
      createdAt: "2026-07-10T09:00:00Z",
    }),
  ]);

  await expect(readSuggestionRecords(workspaceRoot)).rejects.toThrow(
    /schema version.*\.forgelet\/memory-suggestions\.jsonl.*line 1/i,
  );
});

test("a missing decision log reads as an empty list", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-nolog-");
  await expect(readDecisionLogRecords(workspaceRoot)).resolves.toEqual([]);
});

test("typed decision and write records parse; untyped legacy records are decisions", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-log-");
  await writeDecisions(workspaceRoot, [
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_a",
      decision: "accepted",
      decidedAt: "2026-07-10T10:00:00Z",
    }),
    JSON.stringify({
      type: "write-record",
      suggestionId: "mem_a",
      path: ".forgelet/memory.md",
      blockHash: "abc",
      blockBytes: 42,
      writtenAt: "2026-07-10T10:00:01Z",
    }),
    JSON.stringify({ suggestionId: "mem_b", decision: "rejected" }),
  ]);

  const records = await readDecisionLogRecords(workspaceRoot);
  expect(records).toEqual([
    expect.objectContaining({
      type: "decision",
      suggestionId: "mem_a",
      decision: "accepted",
    }),
    expect.objectContaining({ type: "write-record", suggestionId: "mem_a" }),
    expect.objectContaining({
      type: "decision",
      suggestionId: "mem_b",
      decision: "rejected",
    }),
  ]);
});

test("a corrupt decision log line fails naming the file and line", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-badlog-");
  await writeDecisions(workspaceRoot, [
    JSON.stringify({ suggestionId: "mem_a", decision: "accepted" }),
    JSON.stringify({ type: "decision", suggestionId: "mem_b" }),
  ]);

  await expect(readDecisionLogRecords(workspaceRoot)).rejects.toThrow(
    /\.forgelet\/memory-decisions\.jsonl.*line 2/,
  );
});

test("an unknown decision log record type fails naming the file and line", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-records-badtype-");
  await writeDecisions(workspaceRoot, [
    JSON.stringify({ type: "audit", suggestionId: "mem_a" }),
  ]);

  await expect(readDecisionLogRecords(workspaceRoot)).rejects.toThrow(
    /\.forgelet\/memory-decisions\.jsonl.*line 1/,
  );
});
