import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestMemoryBatch } from "../../src/cli/commands/memory.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-batch-"));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  return workspaceRoot;
}

async function writeTrace(
  workspaceRoot: string,
  sessionId: string,
  startedAt: string,
  friction: boolean,
): Promise<void> {
  const events: unknown[] = [
    { type: "session_started", ts: startedAt, sessionId, payload: { workflow: "coding", startedAt } },
  ];
  if (friction)
    events.push({
      type: "tool_result",
      ts: startedAt,
      sessionId,
      payload: { ok: false, toolName: "read_file", summary: "boom", error: { code: "invalid_input", message: "boom" } },
    });
  events.push({
    type: "session_finished",
    ts: startedAt,
    sessionId,
    payload: { status: "completed", finishedAt: startedAt },
  });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", `${sessionId}.jsonl`),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
}

test("the batch gates each Session on Friction and tallies the outcomes", async () => {
  const workspaceRoot = await makeWorkspace();
  await writeTrace(workspaceRoot, "sess_a", "2026-08-01T10:00:00.000Z", true);
  await writeTrace(workspaceRoot, "sess_b", "2026-08-01T11:00:00.000Z", false);
  await writeTrace(workspaceRoot, "sess_c", "2026-08-01T12:00:00.000Z", true);
  // Two friction Sessions, so exactly two Retrospective turns run.
  const model = new FakeModelClient([
    { content: "- In this workspace, A is done with A'.", toolCalls: [] },
    { content: "- In this workspace, C is done with C'.", toolCalls: [] },
  ]);

  const report = await suggestMemoryBatch(workspaceRoot, model);

  expect(report.examined).toBe(3);
  expect(report.admitted).toBe(2);
  expect(report.created).toBe(2);
  expect(report.existing).toBe(0);
  expect(report.failed).toBe(0);
  // The quiet Session never reached the model.
  expect(model.turnInputs).toHaveLength(2);

  const suggestions = (
    await readFile(join(workspaceRoot, ".forgelet", "memory-suggestions.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  expect(suggestions).toHaveLength(2);
});

test("--since limits the batch to the most recent Sessions", async () => {
  const workspaceRoot = await makeWorkspace();
  await writeTrace(workspaceRoot, "sess_old", "2026-08-01T10:00:00.000Z", true);
  await writeTrace(workspaceRoot, "sess_new", "2026-08-01T12:00:00.000Z", true);
  const model = new FakeModelClient([{ content: "- Newest only.", toolCalls: [] }]);

  const report = await suggestMemoryBatch(workspaceRoot, model, { since: 1 });

  expect(report.examined).toBe(1);
  expect(report.admitted).toBe(1);
  expect(report.entries[0]?.sessionId).toBe("sess_new");
});
