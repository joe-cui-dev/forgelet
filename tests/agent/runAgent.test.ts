import assert from "node:assert/strict";
import { test } from "../harness.js";
import { runAgent } from "../../src/agent/runAgent.js";

test("returns a placeholder session summary", async () => {
  const result = await runAgent({
    task: "fix tests",
    contextFiles: ["issue.md"],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25,
    workspaceRoot: "/tmp/example"
  });

  assert.equal(result.session.task, "fix tests");
  assert.equal(result.session.stage, "final");
  assert.match(result.summary, /Forgelet scaffold is ready/);
  assert.match(result.summary, /Context files: issue.md/);
});
