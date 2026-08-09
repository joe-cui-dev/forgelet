import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureMemorySuggestions,
  readSessionFriction,
} from "../../src/memory/index.js";
import { acceptMemorySuggestion } from "../../src/memoryReview/decide.js";
import { listMemoryReview, showMemoryReview } from "../../src/memoryReview/index.js";

async function makeWorkspace(prefix: string): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  return workspaceRoot;
}

/** A finished Session whose Trace carries a Friction Signal (a failed Tool
 * Observation), the shape that fires the Session-end capture prompt. */
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

test("readSessionFriction reports the Session's Friction Signals", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-friction-read-");
  await writeFrictionTrace(workspaceRoot, "sess_read");

  const friction = await readSessionFriction(workspaceRoot, "sess_read");

  expect(friction.signals).toEqual([
    { kind: "tool_failure", toolName: "search_text", errorCode: "invalid_input", error: "ENOTDIR: not a directory" },
  ]);
  expect(friction.lifecycle).toMatchObject({ workflow: "coding", status: "completed" });
});

test("capture records a human line with friction and trace provenance", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-friction-");
  await writeFrictionTrace(workspaceRoot, "sess_friction");

  const text = "In this workspace, search_text matches literal substrings, not regex.";
  const captured = await captureMemorySuggestions(workspaceRoot, "sess_friction", [text], {
    now: () => new Date("2026-07-11T10:03:00.000Z"),
  });

  expect(captured).toHaveLength(1);
  expect(captured[0]?.outcome).toBe("created");
  expect(captured[0]?.state).toBe("proposed");

  const suggestion = captured[0]?.suggestion;
  if (!suggestion) throw new Error("expected a captured suggestion");
  expect(suggestion.schemaVersion).toBe(1);
  expect(suggestion.text).toBe(text);
  expect(suggestion.createdAt).toBe("2026-07-11T10:03:00.000Z");
  expect(suggestion.id).toBe(
    `mem_${createHash("sha256").update(`sess_friction\n${text}`).digest("hex").slice(0, 12)}`,
  );

  const provenance = suggestion.provenance;
  if (!provenance) throw new Error("expected provenance");
  expect(provenance.derivation.frictionSignals).toEqual({
    items: [
      { kind: "tool_failure", toolName: "search_text", errorCode: "invalid_input", error: "ENOTDIR: not a directory" },
    ],
    total: 1,
  });
  expect(provenance.derivationSessionId).toBeUndefined();
  const trace = await readFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_friction.jsonl"),
    "utf8",
  );
  expect(provenance.trace).toEqual({
    path: ".forgelet/sessions/sess_friction.jsonl",
    sha256: createHash("sha256").update(trace).digest("hex"),
    bytes: Buffer.byteLength(trace),
  });
  expect(provenance.session).toMatchObject({
    workflow: "coding",
    status: "completed",
    startedAt: "2026-07-11T10:00:00.000Z",
    finishedAt: "2026-07-11T10:02:00.000Z",
  });
});

test("capture records multiple lines in one call and skips blank ones", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-multi-");
  await writeFrictionTrace(workspaceRoot, "sess_multi");

  const captured = await captureMemorySuggestions(workspaceRoot, "sess_multi", [
    "First convention worth keeping.",
    "   ",
    "Second convention worth keeping.",
  ]);

  expect(captured.map((entry) => entry.suggestion.text)).toEqual([
    "First convention worth keeping.",
    "Second convention worth keeping.",
  ]);
  const suggestions = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(suggestions.trim().split("\n")).toHaveLength(2);
});

test("capture from a quiet Session records an entry with empty derivation", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-quiet-");
  await writeQuietTrace(workspaceRoot, "sess_quiet");

  const captured = await captureMemorySuggestions(workspaceRoot, "sess_quiet", [
    "A convention added by hand after a quiet Session.",
  ]);

  expect(captured).toHaveLength(1);
  const provenance = captured[0]?.suggestion.provenance;
  if (!provenance) throw new Error("expected provenance");
  expect(provenance.derivation).toEqual({});
  expect(provenance.session).toMatchObject({ status: "completed" });
});

test("capturing nothing writes no file", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-empty-");
  await writeFrictionTrace(workspaceRoot, "sess_empty");

  const captured = await captureMemorySuggestions(workspaceRoot, "sess_empty", ["", "  "]);

  expect(captured).toEqual([]);
  await expect(
    readFile(join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("capture deduplicates a line on repeat and preserves its id", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-dedupe-");
  await writeFrictionTrace(workspaceRoot, "sess_dupe");
  const text = "In this workspace, glob the sessions directory rather than descending into it.";

  const first = await captureMemorySuggestions(workspaceRoot, "sess_dupe", [text]);
  const second = await captureMemorySuggestions(workspaceRoot, "sess_dupe", [text]);

  expect(first[0]?.outcome).toBe("created");
  expect(second[0]?.outcome).toBe("existing");
  expect(second[0]?.suggestion.id).toBe(first[0]?.suggestion.id);
  const suggestions = await readFile(
    join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"),
    "utf8",
  );
  expect(suggestions.trim().split("\n")).toHaveLength(1);
});

test("capture reflects the derived decision state on repeat", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-states-");
  await writeFrictionTrace(workspaceRoot, "sess_states");
  const text = "In this workspace, the trace omits the full conversation.";

  const proposed = await captureMemorySuggestions(workspaceRoot, "sess_states", [text]);
  const id = proposed[0]?.suggestion.id ?? "";
  await acceptMemorySuggestion(workspaceRoot, id);

  const afterAccept = await captureMemorySuggestions(workspaceRoot, "sess_states", [text]);
  expect(afterAccept[0]).toMatchObject({ outcome: "existing", state: "accepted" });
});

test("capture validates decision evidence before appending a proposal", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-corrupt-");
  await writeFrictionTrace(workspaceRoot, "sess_corrupt");
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory-decisions.jsonl"),
    `${JSON.stringify({ type: "decision", suggestionId: "mem_broken" })}\n`,
    "utf8",
  );

  await expect(
    captureMemorySuggestions(workspaceRoot, "sess_corrupt", ["Something learned."]),
  ).rejects.toThrow(/\.forgelet\/memory-decisions\.jsonl at line 1/);
});

test("a newly captured proposal is immediately reviewable and decidable", async () => {
  const workspaceRoot = await makeWorkspace("forgelet-capture-review-");
  await writeFrictionTrace(workspaceRoot, "sess_review");

  const created = await captureMemorySuggestions(workspaceRoot, "sess_review", [
    "In this workspace, prefer globbing to descending.",
  ]);
  const id = created[0]?.suggestion.id ?? "";
  const listed = await listMemoryReview(workspaceRoot, { all: false });
  const shown = await showMemoryReview(workspaceRoot, id);
  const accepted = await acceptMemorySuggestion(workspaceRoot, id);

  expect(listed.items).toEqual([expect.objectContaining({ id, state: "proposed" })]);
  expect(shown).toMatchObject({ kind: "suggestion", state: "proposed" });
  expect(accepted).toMatchObject({ action: "accepted", outcome: "decided" });
});
