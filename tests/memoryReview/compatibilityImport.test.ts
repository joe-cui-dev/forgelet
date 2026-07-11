import { mkdtemp, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureCompatibilityImport } from "../../src/memoryReview/compatibilityImport.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  return workspaceRoot;
}

function legacyRecord(
  id: string,
  status: "proposed" | "accepted" | "rejected",
  text = `Guidance for ${id}.`,
): string {
  return JSON.stringify({
    id,
    sourceSessionId: `sess_${id}`,
    text,
    reason: "Derived deterministically.",
    status,
  });
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

async function readLog(workspaceRoot: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    "utf8",
  );
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("legacy accepted status with an existing block imports a decision and a found-existing write record", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-found-");
  const text = "In this workspace, use npm test as verification.";
  await writeSuggestions(workspaceRoot, [
    legacyRecord("mem_old1", "accepted", text),
  ]);
  const block = [
    "## mem_old1",
    "",
    text,
    "",
    "Source Session: sess_mem_old1",
    "Reason: Derived deterministically.",
    "",
  ].join("\n");
  await writeFile(join(workspaceRoot, ".forgelet", "memory.md"), block, "utf8");

  await ensureCompatibilityImport(workspaceRoot);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(2);
  const decision = log[0];
  expect(decision).toMatchObject({
    type: "decision",
    suggestionId: "mem_old1",
    decision: "accepted",
    sourceSessionId: "sess_mem_old1",
    origin: "legacy-status",
    textHash: createHash("sha256").update(text).digest("hex"),
  });
  expect(decision?.decidedAt).toBeUndefined();
  expect(typeof decision?.importedAt).toBe("string");
  expect(typeof decision?.textPreview).toBe("string");

  const writeRecord = log[1];
  expect(writeRecord).toMatchObject({
    type: "write-record",
    suggestionId: "mem_old1",
    origin: "found-existing",
    path: ".forgelet/memory.md",
    blockHash: createHash("sha256").update(block).digest("hex"),
    blockBytes: Buffer.byteLength(block, "utf8"),
  });
  expect(writeRecord?.writtenAt).toBeUndefined();
  expect(typeof writeRecord?.observedAt).toBe("string");
});

test("legacy accepted status with no block imports only the decision, leaving a visible gap", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-gap-");
  await writeSuggestions(workspaceRoot, [legacyRecord("mem_old2", "accepted")]);

  await ensureCompatibilityImport(workspaceRoot);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    type: "decision",
    suggestionId: "mem_old2",
    decision: "accepted",
    origin: "legacy-status",
  });
});

test("legacy rejected status imports a rejection; proposed imports nothing", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-reject-");
  await writeSuggestions(workspaceRoot, [
    legacyRecord("mem_rej", "rejected"),
    legacyRecord("mem_pending", "proposed"),
  ]);

  await ensureCompatibilityImport(workspaceRoot);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({
    type: "decision",
    suggestionId: "mem_rej",
    decision: "rejected",
    origin: "legacy-status",
  });
});

test("a workspace with nothing to import creates no decision log", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-noop-");
  await writeSuggestions(workspaceRoot, [legacyRecord("mem_p", "proposed")]);

  await ensureCompatibilityImport(workspaceRoot);

  await expect(
    stat(join(workspaceRoot, ".forgelet", "memory-decisions.jsonl")),
  ).rejects.toThrow();
});

test("import is idempotent and never rewrites the suggestions file", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-idem-");
  await writeSuggestions(workspaceRoot, [
    legacyRecord("mem_a", "accepted"),
    legacyRecord("mem_b", "rejected"),
  ]);
  const suggestionsPath = join(
    workspaceRoot,
    ".forgelet",
    "memory-suggestions.jsonl",
  );
  const before = await readFile(suggestionsPath, "utf8");

  await ensureCompatibilityImport(workspaceRoot);
  const firstLog = await readLog(workspaceRoot);
  await ensureCompatibilityImport(workspaceRoot);
  const secondLog = await readLog(workspaceRoot);

  expect(secondLog).toEqual(firstLog);
  expect(await readFile(suggestionsPath, "utf8")).toBe(before);
});

test("a block appearing after the import never closes the gap; only re-accept repairs it", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-lateblock-");
  const text = "Guidance whose block shows up late.";
  await writeSuggestions(workspaceRoot, [
    legacyRecord("mem_late", "accepted", text),
  ]);

  await ensureCompatibilityImport(workspaceRoot);
  const firstLog = await readLog(workspaceRoot);
  expect(firstLog).toHaveLength(1);

  // A user hand-edits the heading into Durable Memory afterwards. The file is
  // never gap authority: a later import must not append a write record.
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory.md"),
    `## mem_late\n\n${text}\n`,
    "utf8",
  );
  await ensureCompatibilityImport(workspaceRoot);

  expect(await readLog(workspaceRoot)).toEqual(firstLog);
});

test("an existing log decision wins over the embedded legacy status", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-logwins-");
  await writeSuggestions(workspaceRoot, [legacyRecord("mem_c", "accepted")]);
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_c",
      decision: "rejected",
      decidedAt: "2026-07-01T00:00:00Z",
    }) + "\n",
    "utf8",
  );

  await ensureCompatibilityImport(workspaceRoot);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ decision: "rejected" });
});

test("an invalid suggestion record fails the import before anything is appended", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-invalid-");
  await writeSuggestions(workspaceRoot, [
    legacyRecord("mem_ok", "accepted"),
    JSON.stringify({ id: "mem_broken", status: "accepted" }),
  ]);

  await expect(ensureCompatibilityImport(workspaceRoot)).rejects.toThrow(
    /memory-suggestions\.jsonl.*line 2/,
  );
  await expect(
    stat(join(workspaceRoot, ".forgelet", "memory-decisions.jsonl")),
  ).rejects.toThrow();
});

test("block observation honors a configured memoryFile path", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-config-");
  const text = "Custom target guidance.";
  await writeSuggestions(workspaceRoot, [
    legacyRecord("mem_cfg", "accepted", text),
  ]);
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ memoryFile: "notes/memory.md" }),
    "utf8",
  );
  await mkdir(join(workspaceRoot, "notes"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "notes", "memory.md"),
    `## mem_cfg\n\n${text}\n`,
    "utf8",
  );

  await ensureCompatibilityImport(workspaceRoot);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(2);
  expect(log[1]).toMatchObject({
    type: "write-record",
    suggestionId: "mem_cfg",
    origin: "found-existing",
    path: "notes/memory.md",
  });
});

test("a stale advisory lock from a dead process is taken over", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-import-stalelock-");
  await writeSuggestions(workspaceRoot, [legacyRecord("mem_l", "accepted")]);
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.lock"),
    "99999999",
    "utf8",
  );

  await ensureCompatibilityImport(workspaceRoot);

  const log = await readLog(workspaceRoot);
  expect(log).toHaveLength(1);
  await expect(
    stat(join(workspaceRoot, ".forgelet", "memory-decisions.lock")),
  ).rejects.toThrow();
});
