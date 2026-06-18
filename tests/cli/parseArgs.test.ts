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
    budgetUsd: undefined,
    live: false
  });
});

test("parses run options", () => {
  assert.deepEqual(parseArgs(["--live", "--context", "issue.md", "--model", "deepseek-v4-pro", "--budget", "0.25", "fix bug"]), {
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: ["issue.md"],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25,
    live: true
  });
});

test("parses a writing workflow task", () => {
  assert.deepEqual(parseArgs(["write", "--context", "draft.md", "revise this"]), {
    kind: "run",
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    model: undefined,
    budgetUsd: undefined,
    live: false
  });
});

test("parses non-model config set", () => {
  assert.deepEqual(parseArgs(["config", "set", "memoryFile", ".forgelet/memory.md"]), {
    kind: "config-set",
    key: "memoryFile",
    value: ".forgelet/memory.md"
  });
});

test("rejects config set for model defaults", () => {
  assert.throws(
    () => parseArgs(["config", "set", "defaultModel", "deepseek-v4-flash"]),
    /Model defaults are defined in src\/config\/index\.ts/,
  );
  assert.throws(
    () => parseArgs(["config", "set", "routing.coding.default", "deepseek-v4-flash"]),
    /Model defaults are defined in src\/config\/index\.ts/,
  );
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
