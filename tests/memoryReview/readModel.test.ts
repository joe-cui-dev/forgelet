import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { showMemoryReview, listMemoryReview } from "../../src/memoryReview/index.js";

const ids = new Map<string, string>();

function memoryId(name: string): string {
  const id = ids.get(name);
  if (!id) throw new Error(`Missing fixture id for ${name}`);
  return id;
}

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  return workspaceRoot;
}

function versionedRecord(
  name: string,
  text: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
): string {
  const sourceSessionId = `sess_${name}`;
  const id = `mem_${createHash("sha256")
    .update(`${sourceSessionId}\n${text}`)
    .digest("hex")
    .slice(0, 12)}`;
  ids.set(name, id);
  const { provenance: rawProvenance, ...otherExtra } = extra;
  const suppliedProvenance = rawProvenance as Record<string, unknown> | undefined;
  return JSON.stringify({
    schemaVersion: 1,
    id,
    sourceSessionId,
    text,
    createdAt,
    provenance: {
      derivation: {
        changedFiles: { items: [], total: 0 },
        successfulVerificationCommands: { items: [], total: 0 },
        ...(suppliedProvenance?.derivation as Record<string, unknown> | undefined),
      },
      trace: {
        path: ".forgelet/sessions/missing.jsonl",
        sha256: "0".repeat(64),
        bytes: 0,
        ...(suppliedProvenance?.trace as Record<string, unknown> | undefined),
      },
      session: {
        workflow: "coding",
        status: "completed",
        startedAt: createdAt,
        finishedAt: createdAt,
        ...(suppliedProvenance?.session as Record<string, unknown> | undefined),
      },
    },
    ...otherExtra,
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
        suggestionId: memoryId("mem_written"),
        decision: "accepted",
        decidedAt: "2026-07-05T00:00:00Z",
      }),
      JSON.stringify({
        type: "write-record",
        suggestionId: memoryId("mem_written"),
        path: ".forgelet/memory.md",
        blockHash: "aa",
        blockBytes: 10,
        writtenAt: "2026-07-05T00:00:01Z",
      }),
      JSON.stringify({
        type: "decision",
        suggestionId: memoryId("mem_gap"),
        decision: "accepted",
        decidedAt: "2026-07-05T00:01:00Z",
      }),
      JSON.stringify({
        type: "decision",
        suggestionId: memoryId("mem_rej"),
        decision: "rejected",
        decidedAt: "2026-07-05T00:02:00Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const actionable = await listMemoryReview(workspaceRoot, { all: false });
  expect(actionable.items.map((item) => [item.id, item.state])).toEqual([
    [memoryId("mem_gap"), "accepted-unwritten"],
    [memoryId("mem_new"), "proposed"],
  ]);
  expect(actionable.hiddenDecidedCount).toBe(2);
  expect(actionable.items[1]).toMatchObject({
    createdAt: "2026-07-04T00:00:00Z",
    preview: "Pending guidance.",
  });

  const all = await listMemoryReview(workspaceRoot, { all: true });
  expect(all.items.map((item) => [item.id, item.state])).toEqual([
    [memoryId("mem_written"), "accepted"],
    [memoryId("mem_gap"), "accepted-unwritten"],
    [memoryId("mem_rej"), "rejected"],
    [memoryId("mem_new"), "proposed"],
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
        suggestionId: memoryId("mem_dup"),
        decision: "rejected",
        decidedAt: "2026-07-02T00:00:00Z",
      }),
      JSON.stringify({
        type: "decision",
        suggestionId: memoryId("mem_dup"),
        decision: "accepted",
        decidedAt: "2026-07-03T00:00:00Z",
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const all = await listMemoryReview(workspaceRoot, { all: true });
  expect(all.items).toEqual([
    expect.objectContaining({ id: memoryId("mem_dup"), state: "rejected" }),
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

test("show derives live Trace Corroboration and exact preview bytes for a proposed suggestion", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-show-");
  const tracePath = ".forgelet/sessions/sess_show.jsonl";
  const trace = '{"type":"session_finished"}\n';
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  await writeFile(join(workspaceRoot, tracePath), trace, "utf8");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    versionedRecord("mem_show", "Keep this guidance.", "2026-07-10T09:00:00Z", {
      provenance: {
        derivation: {
          changedFiles: { items: ["src/a.ts"], total: 1 },
          successfulVerificationCommands: { items: ["npm test"], total: 1 },
        },
        trace: {
          path: tracePath,
          sha256: createHash("sha256").update(trace).digest("hex"),
          bytes: Buffer.byteLength(trace),
        },
        session: {
          workflow: "coding",
          status: "completed",
          startedAt: "2026-07-10T08:00:00Z",
          finishedAt: "2026-07-10T08:01:00Z",
        },
      },
    }) + "\n",
    "utf8",
  );

  const shown = await showMemoryReview(workspaceRoot, memoryId("mem_show"));

  expect(shown).toMatchObject({
    kind: "suggestion",
    state: "proposed",
    traceCorroboration: "verified",
    destination: ".forgelet/memory.md",
  });
  expect(shown.kind === "suggestion" && shown.renderedBlock).toEqual({
    bytes: `## ${memoryId("mem_show")}\n\nKeep this guidance.\n\nSource Session: sess_mem_show\n`,
    finalNewline: true,
    byteCount: Buffer.byteLength(`## ${memoryId("mem_show")}\n\nKeep this guidance.\n\nSource Session: sess_mem_show\n`),
    sha256: createHash("sha256")
      .update(`## ${memoryId("mem_show")}\n\nKeep this guidance.\n\nSource Session: sess_mem_show\n`)
      .digest("hex"),
  });
});

test("show exposes an orphan decision without manufacturing a suggestion", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-orphan-");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    JSON.stringify({
      type: "decision",
      suggestionId: "mem_orphan",
      decision: "rejected",
      decidedAt: "2026-07-10T10:00:00Z",
      sourceSessionId: "sess_orphan",
      textHash: "abc",
      textPreview: "Lost guidance.",
      traceCorroboration: "missing",
    }) + "\n",
    "utf8",
  );

  await expect(showMemoryReview(workspaceRoot, "mem_orphan")).resolves.toMatchObject({
    kind: "orphan-decision",
    decision: expect.objectContaining({ suggestionId: "mem_orphan" }),
  });
});

test("show distinguishes changed, missing, and unreadable Trace evidence", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-corroboration-");
  await mkdir(join(workspaceRoot, ".forgelet", "directory-trace.jsonl"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "changed.jsonl"),
    "current bytes\n",
    "utf8",
  );
  const provenance = (path: string) => ({
    derivation: {
      changedFiles: { items: [], total: 0 },
      successfulVerificationCommands: { items: [], total: 0 },
    },
    trace: { path, sha256: "0".repeat(64), bytes: 1 },
    session: {
      workflow: "coding",
      status: "completed",
      startedAt: "2026-07-01T00:00:00Z",
      finishedAt: "2026-07-01T00:01:00Z",
    },
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    [
      versionedRecord("mem_differs", "Changed trace.", "2026-07-01T00:00:00Z", { provenance: provenance(".forgelet/changed.jsonl") }),
      versionedRecord("mem_missing", "Missing trace.", "2026-07-02T00:00:00Z", { provenance: provenance(".forgelet/gone.jsonl") }),
      versionedRecord("mem_unreadable", "Unreadable trace.", "2026-07-03T00:00:00Z", { provenance: provenance(".forgelet/directory-trace.jsonl") }),
    ].join("\n") + "\n",
    "utf8",
  );

  await expect(showMemoryReview(workspaceRoot, memoryId("mem_differs"))).resolves.toMatchObject({ traceCorroboration: "differs" });
  await expect(showMemoryReview(workspaceRoot, memoryId("mem_missing"))).resolves.toMatchObject({ traceCorroboration: "missing" });
  await expect(showMemoryReview(workspaceRoot, memoryId("mem_unreadable"))).resolves.toMatchObject({ traceCorroboration: "unreadable" });
});

test("show keeps settled decision evidence authoritative and resolves an external destination", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-readmodel-settled-");
  const externalMemory = join(tmpdir(), "forgelet-external-memory.md");
  const provenance = (path: string) => ({
    derivation: {
      changedFiles: { items: [], total: 0 },
      successfulVerificationCommands: { items: [], total: 0 },
    },
    trace: { path, sha256: "0".repeat(64), bytes: 1 },
    session: {
      workflow: "coding",
      status: "completed",
      startedAt: "2026-07-01T00:00:00Z",
      finishedAt: "2026-07-01T00:01:00Z",
    },
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ memoryFile: externalMemory }),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    versionedRecord("mem_gap", "Repair this guidance.", "2026-07-01T00:00:00Z", { provenance: provenance(".forgelet/gap.jsonl") }) + "\n" +
      versionedRecord("mem_written", "Already written.", "2026-07-02T00:00:00Z", { provenance: provenance(".forgelet/written.jsonl") }) + "\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    [
      JSON.stringify({ type: "decision", suggestionId: memoryId("mem_gap"), decision: "accepted" }),
      JSON.stringify({ type: "decision", suggestionId: memoryId("mem_written"), decision: "accepted", intendedPath: ".forgelet/memory.md", intendedBlockHash: "abc", intendedBlockBytes: 12 }),
      JSON.stringify({ type: "write-record", suggestionId: memoryId("mem_written"), path: ".forgelet/memory.md", blockHash: "def", blockBytes: 13 }),
    ].join("\n") + "\n",
    "utf8",
  );

  const gap = await showMemoryReview(workspaceRoot, memoryId("mem_gap"));
  expect(gap).toMatchObject({ state: "accepted-unwritten", destination: externalMemory });
  const written = await showMemoryReview(workspaceRoot, memoryId("mem_written"));
  expect(written).toMatchObject({ state: "accepted", decision: expect.objectContaining({ intendedPath: ".forgelet/memory.md" }), writeRecord: expect.objectContaining({ blockHash: "def" }) });
  expect(written.kind === "suggestion" && written.renderedBlock).toBeUndefined();
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
            sha256: "0".repeat(64),
            bytes: 1,
          },
        },
      }),
      versionedRecord("mem_unread", "Trace unreadable.", "2026-07-02T00:00:00Z", {
        provenance: {
          trace: {
            path: ".forgelet/unreadable-trace.jsonl",
            sha256: "0".repeat(64),
            bytes: 1,
          },
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const list = await listMemoryReview(workspaceRoot, { all: false });
  expect(list.items.map((item) => item.id)).toEqual([
    memoryId("mem_absent"),
    memoryId("mem_unread"),
  ]);
});
