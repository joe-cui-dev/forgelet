import { expect, test } from "@jest/globals";
import { formatQueue } from "../../../src/cli/present/queue.js";

test("formatQueue reports when nothing is paused", () => {
  expect(formatQueue([])).toBe("No Sessions are paused.");
});

test("formatQueue lists paused sessions with their pending action", () => {
  const output = formatQueue([
    {
      sessionId: "sess_abc",
      task: "write docs",
      pendingToolName: "apply_patch",
      pendingTargets: ["docs/notes.md"],
      pausedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);

  expect(output).toMatch(/sess_abc/);
  expect(output).toMatch(/write docs/);
  expect(output).toMatch(/apply_patch/);
  expect(output).toMatch(/docs\/notes\.md/);
  expect(output).toMatch(/forge decide sess_abc/);
});
