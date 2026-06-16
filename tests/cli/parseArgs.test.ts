import assert from "node:assert/strict";
import { test } from "../harness.js";
import { parseArgs } from "../../src/cli/parseArgs.js";

test("parses a simple run task", () => {
  assert.deepEqual(parseArgs(["fix", "tests"]), {
    kind: "run",
    workflow: "coding",
    task: "fix tests",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined
  });
});

test("parses run options", () => {
  assert.deepEqual(parseArgs(["--context", "issue.md", "--model", "deepseek-v4-pro", "--budget", "0.25", "fix bug"]), {
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: ["issue.md"],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25
  });
});

test("parses a writing workflow task", () => {
  assert.deepEqual(parseArgs(["write", "--context", "draft.md", "revise this"]), {
    kind: "run",
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    model: undefined,
    budgetUsd: undefined
  });
});

test("parses config set", () => {
  assert.deepEqual(parseArgs(["config", "set", "defaultModel", "deepseek-v4-pro"]), {
    kind: "config-set",
    key: "defaultModel",
    value: "deepseek-v4-pro"
  });
});

test("parses memory commands", () => {
  assert.deepEqual(parseArgs(["memory", "suggest", "sess_123"]), {
    kind: "memory-suggest",
    sessionId: "sess_123"
  });
  assert.deepEqual(parseArgs(["memory", "accept", "mem_123"]), {
    kind: "memory-accept",
    suggestionId: "mem_123"
  });
});

test("rejects missing task", () => {
  assert.throws(() => parseArgs(["--model", "deepseek-v4-pro"]), /Usage: forge/);
});
