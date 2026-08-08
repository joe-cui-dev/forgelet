import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestMemoryFromSession } from "../../src/memory/index.js";
import { acceptMemorySuggestion, rejectMemorySuggestion } from "../../src/memoryReview/decide.js";
import { listMemoryReview, showMemoryReview } from "../../src/memoryReview/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  return workspaceRoot;
}

/** A finished Session whose Trace carries a Friction Signal (a failed Tool
 * Observation), so the Retrospective gate admits it. */
async function writeFrictionTrace(
  workspaceRoot: string,
  sessionId: string,
  input: { workflow?: string } = {},
): Promise<void> {
  const trace = [
    {
      type: "session_started",
      ts: "2026-07-11T10:00:00.000Z",
      sessionId,
      payload: { workflow: input.workflow ?? "coding", startedAt: "2026-07-11T10:00:00.000Z" },
    },
    {
      type: "tool_result",
      ts: "2026-07-11T10:00:30.000Z",
      sessionId,
      payload: {
        ok: false,
        toolCallId: "call_1",
        toolName: "search_text",
        summary: "ENOTDIR: not a directory",
        error: { code: "invalid_input", message: "ENOTDIR: not a directory" },
      },
    },
    {
      type: "session_finished",
      ts: "2026-07-11T10:02:00.000Z",
      sessionId,
      payload: { status: "completed", finishedAt: "2026-07-11T10:02:00.000Z" },
    },
  ];
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`),
    trace.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

/** A finished Session with no failed observation and no denied decision. */
async function writeQuietTrace(workspaceRoot: string, sessionId: string): Promise<void> {
  const trace = [
    {
      type: "session_started",
      ts: "2026-07-11T10:00:00.000Z",
      sessionId,
      payload: { workflow: "coding", startedAt: "2026-07-11T10:00:00.000Z" },
    },
    {
      type: "session_finished",
      ts: "2026-07-11T10:02:00.000Z",
      sessionId,
      payload: { status: "completed", finishedAt: "2026-07-11T10:02:00.000Z" },
    },
  ];
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`),
    trace.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

function modelWith(...contents: string[]): FakeModelClient {
  return new FakeModelClient(contents.map((content) => ({ content, toolCalls: [] })));
}

test("suggest derives proposals from a friction Session via a Retrospective Session", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-friction-");
  await writeFrictionTrace(workspaceRoot, "sess_friction");
  const model = modelWith(
    "- In this workspace, search_text expects a directory, not a file path.\n- In this workspace, prefer read_file for single files.",
  );

  const result = await suggestMemoryFromSession(workspaceRoot, "sess_friction", {
    modelClient: model,
    now: () => new Date("2026-07-11T10:03:00.000Z"),
  });

  expect(result.admitted).toBe(true);
  expect(result.derivationSessionId).toMatch(/^sess_/);
  expect(result.suggestions).toHaveLength(2);
  expect(result.suggestions.map((entry) => entry.outcome)).toEqual(["created", "created"]);
  expect(result.suggestions.map((entry) => entry.state)).toEqual(["proposed", "proposed"]);

  const first = result.suggestions[0]?.suggestion;
  if (!first) throw new Error("expected a first suggestion");
  expect(first.schemaVersion).toBe(1);
  expect(first.text).toBe("In this workspace, search_text expects a directory, not a file path.");
  expect(first.id).toBe(
    `mem_${createHash("sha256").update(`sess_friction\n${first.text}`).digest("hex").slice(0, 12)}`,
  );
  const provenance = first.provenance;
  if (!provenance) throw new Error("expected provenance");
  expect(provenance.derivation.frictionSignals).toEqual({
    items: [
      { kind: "tool_failure", toolName: "search_text", errorCode: "invalid_input", error: "ENOTDIR: not a directory" },
    ],
    total: 1,
  });
  expect(provenance.derivationSessionId).toBe(result.derivationSessionId);
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_friction.jsonl"),
    "utf8",
  );
  expect(provenance.trace).toEqual({
    path: ".forgelet/sessions/sess_friction.jsonl",
    sha256: createHash("sha256").update(trace).digest("hex"),
    bytes: Buffer.byteLength(trace),
  });
  expect(provenance.session).toMatchObject({ workflow: "coding", status: "completed" });
});

test("a Session with no Friction Signal yields nothing without calling the model", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-quiet-");
  await writeQuietTrace(workspaceRoot, "sess_quiet");
  const model = modelWith(); // no scripted turns: it must never be called

  const result = await suggestMemoryFromSession(workspaceRoot, "sess_quiet", { modelClient: model });

  expect(result).toEqual({ sourceSessionId: "sess_quiet", admitted: false, suggestions: [] });
  expect(model.turnInputs).toHaveLength(0);
  await expect(
    readFile(join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("suggest deduplicates a proposal on repeat and preserves its id", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-dedupe-");
  await writeFrictionTrace(workspaceRoot, "sess_dupe");
  const text = "- In this workspace, glob the sessions directory rather than descending into it.";
  const model = modelWith(text, text);

  const first = await suggestMemoryFromSession(workspaceRoot, "sess_dupe", { modelClient: model });
  const second = await suggestMemoryFromSession(workspaceRoot, "sess_dupe", { modelClient: model });

  expect(first.suggestions[0]?.outcome).toBe("created");
  expect(second.suggestions[0]?.outcome).toBe("existing");
  expect(second.suggestions[0]?.suggestion.id).toBe(first.suggestions[0]?.suggestion.id);
  const suggestions = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(suggestions.trim().split("\n")).toHaveLength(1);
});

test("suggest deduplicates identical bullets within one Retrospective output", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-inner-dedupe-");
  await writeFrictionTrace(workspaceRoot, "sess_inner");
  const model = modelWith(
    "- In this workspace, run only configured safe commands.\n- In this workspace, run only configured safe commands.",
  );

  const result = await suggestMemoryFromSession(workspaceRoot, "sess_inner", { modelClient: model });

  expect(result.suggestions).toHaveLength(1);
  const suggestions = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(suggestions.trim().split("\n")).toHaveLength(1);
});

test("suggest reflects the derived decision state on repeat", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-states-");
  await writeFrictionTrace(workspaceRoot, "sess_states");
  const text = "- In this workspace, the trace omits the full conversation.";
  const model = modelWith(text, text);

  const proposed = await suggestMemoryFromSession(workspaceRoot, "sess_states", { modelClient: model });
  const id = proposed.suggestions[0]?.suggestion.id ?? "";
  await acceptMemorySuggestion(workspaceRoot, id);

  const afterAccept = await suggestMemoryFromSession(workspaceRoot, "sess_states", { modelClient: model });
  expect(afterAccept.suggestions[0]).toMatchObject({ outcome: "existing", state: "accepted" });
});

test("suggest validates decision evidence before appending a proposal", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-corrupt-");
  await writeFrictionTrace(workspaceRoot, "sess_corrupt");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    `${JSON.stringify({ type: "decision", suggestionId: "mem_broken" })}\n`,
    "utf8",
  );
  const model = modelWith("- In this workspace, something was learned.");

  await expect(
    suggestMemoryFromSession(workspaceRoot, "sess_corrupt", { modelClient: model }),
  ).rejects.toThrow(/\.forgelet\/memory-decisions\.jsonl at line 1/);
});

test("a newly suggested proposal is immediately reviewable and decidable", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-suggest-review-");
  await writeFrictionTrace(workspaceRoot, "sess_review");
  const model = modelWith("- In this workspace, prefer globbing to descending.");

  const created = await suggestMemoryFromSession(workspaceRoot, "sess_review", { modelClient: model });
  const id = created.suggestions[0]?.suggestion.id ?? "";
  const listed = await listMemoryReview(workspaceRoot, { all: false });
  const shown = await showMemoryReview(workspaceRoot, id);
  const accepted = await acceptMemorySuggestion(workspaceRoot, id);

  expect(listed.items).toEqual([expect.objectContaining({ id, state: "proposed" })]);
  expect(shown).toMatchObject({ kind: "suggestion", state: "proposed" });
  expect(accepted).toMatchObject({ action: "accepted", outcome: "decided" });
});
