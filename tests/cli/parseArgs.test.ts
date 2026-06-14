import assert from "node:assert/strict";
import { test } from "../harness.js";
import { parseArgs } from "../../src/cli/parseArgs.js";

test("parses a simple run task", () => {
  assert.deepEqual(parseArgs(["fix", "tests"]), {
    kind: "run",
    task: "fix tests",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined
  });
});

test("parses run options", () => {
  assert.deepEqual(parseArgs(["--context", "issue.md", "--model", "deepseek-v4-pro", "--budget", "0.25", "fix bug"]), {
    kind: "run",
    task: "fix bug",
    contextFiles: ["issue.md"],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25
  });
});

test("parses config set", () => {
  assert.deepEqual(parseArgs(["config", "set", "defaultModel", "deepseek-v4-pro"]), {
    kind: "config-set",
    key: "defaultModel",
    value: "deepseek-v4-pro"
  });
});

test("rejects missing task", () => {
  assert.throws(() => parseArgs(["--model", "deepseek-v4-pro"]), /Usage: forge/);
});
