import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMemoryReview } from "../../src/memoryReview/index.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  return workspaceRoot;
}

function versionedRecord(
  id: string,
  text: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    sourceSessionId: `sess_${id}`,
    text,
    createdAt,
    ...extra,
  });
}

test("default scope lists only actionable items in append order; --all adds decided history", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-scope-");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    [
      versionedRecord("mem_written", "Written guidance.", "2026-07-01T00:00:00Z"),
      versionedRecord("mem_gap", "Gapped guidance.", "2026-07-02T00:00:00Z"),
      versionedRecord("mem_rej", "Rejected guidance.", "2026-07-03T00:00:00Z"),
      versionedRecord("mem_new", "Pending guidance.", "2026-07-04T00:00:00Z"),
    ].join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    [
      JSON.stringify({
        type: "decision",
        suggestionId: "mem_written",
        decision: "accepted",
        decidedAt: "2026-07-05T00:00:00Z",
      }),
      JSON.stringify({
        type: "write-record",
        suggestionId: "mem_written",
        path: ".forgelet/memory.md",
        blockHash: "aa",
        blockBytes: 10,
        writtenAt: "2026-07-05T00:00:01Z",
      }),
      JSON.stringify({
        type: "decision",
        suggestionId: "mem_gap",
        decision: "accepted",
        decidedAt: "2026-07-05T00:01:00Z",
      }),
      JSON.stringify({
        type: "decision",
        suggestionId: "mem_rej",
        decision: "rejected",
        decidedAt: "2026-07-05T00:02:00Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const actionable = await listMemoryReview(workspaceRoot, { all: false });
  expect(actionable.items.map((item) => [item.id, item.state])).toEqual([
    ["mem_gap", "accepted-unwritten"],
    ["mem_new", "proposed"],
  ]);
  expect(actionable.hiddenDecidedCount).toBe(2);
  expect(actionable.items[1]).toMatchObject({
    createdAt: "2026-07-04T00:00:00Z",
    preview: "Pending guidance.",
  });

  const all = await listMemoryReview(workspaceRoot, { all: true });
  expect(all.items.map((item) => [item.id, item.state])).toEqual([
    ["mem_written", "accepted"],
    ["mem_gap", "accepted-unwritten"],
    ["mem_rej", "rejected"],
    ["mem_new", "proposed"],
  ]);
  expect(all.hiddenDecidedCount).toBe(0);
});

test("the first decision per suggestion wins", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-first-");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    versionedRecord("mem_dup", "Twice decided.", "2026-07-01T00:00:00Z") + "\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    [
      JSON.stringify({
        type: "decision",
        suggestionId: "mem_dup",
        decision: "rejected",
        decidedAt: "2026-07-02T00:00:00Z",
      }),
      JSON.stringify({
        type: "decision",
        suggestionId: "mem_dup",
        decision: "accepted",
        decidedAt: "2026-07-03T00:00:00Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const all = await listMemoryReview(workspaceRoot, { all: true });
  expect(all.items).toEqual([
    expect.objectContaining({ id: "mem_dup", state: "rejected" }),
  ]);
});

test("legacy records import on first list and derive states without createdAt", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-legacy-");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    [
      JSON.stringify({
        id: "mem_oldgap",
        sourceSessionId: "sess_a",
        text: "Old accepted, block gone.",
        reason: "r",
        status: "accepted",
      }),
      JSON.stringify({
        id: "mem_oldnew",
        sourceSessionId: "sess_b",
        text: "Old pending.",
        reason: "r",
        status: "proposed",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const actionable = await listMemoryReview(workspaceRoot, { all: false });
  expect(actionable.items.map((item) => [item.id, item.state])).toEqual([
    ["mem_oldgap", "accepted-unwritten"],
    ["mem_oldnew", "proposed"],
  ]);
  expect(actionable.items[0]?.createdAt).toBeUndefined();
});

test("a missing suggestions file lists as empty", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-empty-");
  const list = await listMemoryReview(workspaceRoot, { all: false });
  expect(list.items).toEqual([]);
  expect(list.hiddenDecidedCount).toBe(0);
});

test("listing succeeds when a referenced Trace is absent or unreadable", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-trace-");
  await mkdir(join(workspaceRoot, ".forgelet", "unreadable-trace.jsonl"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    [
      versionedRecord("mem_absent", "Trace absent.", "2026-07-01T00:00:00Z", {
        provenance: {
          trace: {
            path: ".forgelet/sessions/sess_gone.jsonl",
            sha256: "00",
            bytes: 1,
          },
        },
      }),
      versionedRecord("mem_unread", "Trace unreadable.", "2026-07-02T00:00:00Z", {
        provenance: {
          trace: {
            path: ".forgelet/unreadable-trace.jsonl",
            sha256: "00",
            bytes: 1,
          },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const list = await listMemoryReview(workspaceRoot, { all: false });
  expect(list.items.map((item) => item.id)).toEqual([
    "mem_absent",
    "mem_unread",
  ]);
});
