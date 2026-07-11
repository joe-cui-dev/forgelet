import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptMemorySuggestion,
  rejectMemorySuggestion,
} from "../../src/memoryReview/decide.js";
import { showMemoryReview } from "../../src/memoryReview/index.js";
import { renderMemoryBlock } from "../../src/memoryReview/renderedMemoryBlock.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  return workspaceRoot;
}

function legacySuggestion(id: string, text: string): string {
  return JSON.stringify({
    id,
    sourceSessionId: `sess_${id}`,
    text,
    reason: "Derived deterministically.",
    status: "proposed",
  });
}

async function writeSuggestions(workspaceRoot: string, lines: string[]): Promise<void> {
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    lines.join("\n") + "\n",
    "utf8",
  );
}

async function readLog(workspaceRoot: string): Promise<Record<string, unknown>[]> {
  let content: string;
  try {
    content = await readFile(join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"), "utf8");
  } catch {
    return [];
  }
  return content
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("accept appends a decision then a write record with the renderer's exact bytes", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-accept-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_a", "Remember this.")]);

  const result = await acceptMemorySuggestion(workspaceRoot, "mem_a", {
    now: () => new Date("2026-07-11T10:00:00Z"),
  });

  expect(result.outcome).toBe("decided");
  const rendered = renderMemoryBlock({
    id: "mem_a",
    text: "Remember this.",
    sourceSessionId: "sess_mem_a",
    reason: "Derived deterministically.",
  });
  expect(result.write).toEqual({
    path: ".forgelet/memory.md",
    blockHash: rendered.sha256,
    blockBytes: rendered.byteCount,
  });

  const memory = await readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8");
  expect(memory).toBe(rendered.bytes);

  const log = await readLog(workspaceRoot);
  expect(log).toEqual([
    expect.objectContaining({
      type: "decision",
      suggestionId: "mem_a",
      decision: "accepted",
      decidedAt: "2026-07-11T10:00:00.000Z",
      intendedPath: ".forgelet/memory.md",
      intendedBlockHash: rendered.sha256,
    }),
    expect.objectContaining({
      type: "write-record",
      suggestionId: "mem_a",
      path: ".forgelet/memory.md",
      blockHash: rendered.sha256,
    }),
  ]);
});

test("reject never writes Durable Memory", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-reject-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_r", "Do not remember this.")]);

  const result = await rejectMemorySuggestion(workspaceRoot, "mem_r");

  expect(result).toMatchObject({ suggestionId: "mem_r", action: "rejected", outcome: "decided" });
  expect(result.write).toBeUndefined();
  await expect(
    readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });

  const log = await readLog(workspaceRoot);
  expect(log).toEqual([
    expect.objectContaining({ type: "decision", suggestionId: "mem_r", decision: "rejected" }),
  ]);
});

test("repeating the same terminal acceptance is idempotent and appends nothing new", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-repeat-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_dup", "Idempotent guidance.")]);

  const first = await acceptMemorySuggestion(workspaceRoot, "mem_dup");
  const logAfterFirst = await readLog(workspaceRoot);

  const second = await acceptMemorySuggestion(workspaceRoot, "mem_dup");
  const logAfterSecond = await readLog(workspaceRoot);

  expect(second.outcome).toBe("repeated");
  expect(second.decidedAt).toBe(first.decidedAt);
  expect(second.write).toEqual(first.write);
  expect(logAfterSecond).toEqual(logAfterFirst);
});

test("repeating a rejection is idempotent", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-repeat-reject-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_rr", "Reject twice.")]);

  await rejectMemorySuggestion(workspaceRoot, "mem_rr");
  const logAfterFirst = await readLog(workspaceRoot);
  const second = await rejectMemorySuggestion(workspaceRoot, "mem_rr");

  expect(second.outcome).toBe("repeated");
  expect(await readLog(workspaceRoot)).toEqual(logAfterFirst);
});

test("a conflicting decision is refused, naming the existing decision and time", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-conflict-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_c", "Conflicted guidance.")]);

  await rejectMemorySuggestion(workspaceRoot, "mem_c", {
    now: () => new Date("2026-07-11T11:00:00Z"),
  });

  await expect(acceptMemorySuggestion(workspaceRoot, "mem_c")).rejects.toThrow(
    /mem_c was already rejected at 2026-07-11T11:00:00\.000Z; cannot accept it\./,
  );

  const log = await readLog(workspaceRoot);
  expect(log).toEqual([
    expect.objectContaining({ type: "decision", suggestionId: "mem_c", decision: "rejected" }),
  ]);
});

test("re-accept repairs a Memory Write Gap without duplicating the decision", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-gap-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_gap", "Gapped guidance.")]);
  // Simulate a crash after the decision append but before the write.
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_gap",
      decision: "accepted",
      decidedAt: "2026-07-11T09:00:00Z",
    }) + "\n",
    "utf8",
  );

  const result = await acceptMemorySuggestion(workspaceRoot, "mem_gap");

  expect(result.outcome).toBe("repaired");
  expect(result.decidedAt).toBe("2026-07-11T09:00:00Z");
  expect(result.write).toBeDefined();

  const memory = await readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8");
  expect(memory).toContain("## mem_gap");

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(2);
  expect(log[0]).toMatchObject({ type: "decision", suggestionId: "mem_gap" });
  expect(log[1]).toMatchObject({ type: "write-record", suggestionId: "mem_gap" });
});

test("repair finds an existing block and records found-existing evidence instead of duplicating it", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-found-");
  const text = "Guidance whose block already exists.";
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_found", text)]);
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_found",
      decision: "accepted",
      decidedAt: "2026-07-11T09:00:00Z",
    }) + "\n",
    "utf8",
  );
  const rendered = renderMemoryBlock({
    id: "mem_found",
    text,
    sourceSessionId: "sess_mem_found",
    reason: "Derived deterministically.",
  });
  await writeFile(join(workspaceRoot, ".forgelet", "memory.md"), rendered.bytes, "utf8");

  const result = await acceptMemorySuggestion(workspaceRoot, "mem_found");

  expect(result.outcome).toBe("repaired");
  expect(result.write).toEqual({
    path: ".forgelet/memory.md",
    blockHash: rendered.sha256,
    blockBytes: rendered.byteCount,
  });

  const memory = await readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8");
  expect(memory).toBe(rendered.bytes);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(2);
  expect(log[1]).toMatchObject({
    type: "write-record",
    suggestionId: "mem_found",
    origin: "found-existing",
  });
});

test("accept's write bytes match show's rendered preview exactly", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-renderer-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_preview", "Preview must match write.")]);

  const shown = await showMemoryReview(workspaceRoot, "mem_preview");
  const preview = shown.kind === "suggestion" ? shown.renderedBlock : undefined;
  expect(preview).toBeDefined();

  await acceptMemorySuggestion(workspaceRoot, "mem_preview");
  const memory = await readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8");

  expect(memory).toBe(preview!.bytes);
});

test("a repair honestly records path drift between the original intent and the actual write", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-drift-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_drift", "Guidance that outlives its config.")]);
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_drift",
      decision: "accepted",
      decidedAt: "2026-07-11T09:00:00Z",
      intendedPath: ".forgelet/memory.md",
    }) + "\n",
    "utf8",
  );
  // The workspace's Durable Memory destination moves before the gap is repaired.
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ memoryFile: ".forgelet/relocated-memory.md" }),
    "utf8",
  );

  const result = await acceptMemorySuggestion(workspaceRoot, "mem_drift");

  expect(result.write?.path).toBe(".forgelet/relocated-memory.md");
  const log = await readLog(workspaceRoot);
  expect(log[0]).toMatchObject({ intendedPath: ".forgelet/memory.md" });
  expect(log[1]).toMatchObject({ path: ".forgelet/relocated-memory.md" });
  await expect(
    readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("concurrent accept attempts on the same suggestion produce exactly one decision and one write", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-concurrent-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_race", "Only one winner.")]);

  const results = await Promise.all(
    Array.from({ length: 8 }, () => acceptMemorySuggestion(workspaceRoot, "mem_race")),
  );

  expect(results.every((entry) => entry.write !== undefined)).toBe(true);
  expect(results.filter((entry) => entry.outcome === "decided")).toHaveLength(1);

  const log = await readLog(workspaceRoot);
  expect(log.filter((entry) => entry.type === "decision")).toHaveLength(1);
  expect(log.filter((entry) => entry.type === "write-record")).toHaveLength(1);

  const memory = await readFile(join(workspaceRoot, ".forgelet", "memory.md"), "utf8");
  expect(memory.match(/## mem_race/g)).toHaveLength(1);
});

test("repeating a decision for an orphaned suggestion (no matching suggestion record) is idempotent", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-orphan-repeat-");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_orphan",
      decision: "rejected",
      decidedAt: "2026-07-11T09:00:00Z",
    }) + "\n",
    "utf8",
  );

  const result = await rejectMemorySuggestion(workspaceRoot, "mem_orphan");

  expect(result).toEqual({
    suggestionId: "mem_orphan",
    action: "rejected",
    outcome: "repeated",
    decidedAt: "2026-07-11T09:00:00Z",
  });
  expect(await readLog(workspaceRoot)).toHaveLength(1);
});

test("a conflicting decision for an orphaned suggestion is refused", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-orphan-conflict-");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_orphan_c",
      decision: "accepted",
      decidedAt: "2026-07-11T09:00:00Z",
    }) + "\n",
    "utf8",
  );

  await expect(rejectMemorySuggestion(workspaceRoot, "mem_orphan_c")).rejects.toThrow(
    /mem_orphan_c was already accepted at 2026-07-11T09:00:00Z; cannot reject it\./,
  );
});

test("deciding a suggestion id with no suggestion record and no decision fails", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-notfound-");
  await expect(acceptMemorySuggestion(workspaceRoot, "mem_nope")).rejects.toThrow(
    "Memory suggestion not found: mem_nope",
  );
});

test("concurrent accept and reject on the same suggestion leave exactly one winning decision", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-decide-race-mixed-");
  await writeSuggestions(workspaceRoot, [legacySuggestion("mem_mixed", "Racing decisions.")]);

  const settled = await Promise.allSettled([
    acceptMemorySuggestion(workspaceRoot, "mem_mixed"),
    rejectMemorySuggestion(workspaceRoot, "mem_mixed"),
    acceptMemorySuggestion(workspaceRoot, "mem_mixed"),
    rejectMemorySuggestion(workspaceRoot, "mem_mixed"),
  ]);

  const log = await readLog(workspaceRoot);
  const decisions = log.filter((entry) => entry.type === "decision");
  expect(decisions).toHaveLength(1);

  const winner = decisions[0]?.decision;
  const fulfilled = settled.filter(
    (entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptMemorySuggestion>>> =>
      entry.status === "fulfilled",
  );
  const rejected = settled.filter((entry) => entry.status === "rejected");

  expect(fulfilled).toHaveLength(2);
  expect(rejected).toHaveLength(2);
  expect(fulfilled.every((entry) => entry.value.action === winner)).toBe(true);
});
