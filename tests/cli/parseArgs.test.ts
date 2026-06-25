import { expect, test } from "@jest/globals";
import { parseArgs } from "../../src/cli/parseArgs.js";

test("parses a simple run task", () => {
  expect(parseArgs(["fix", "tests"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix tests",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    live: false,
    act: false
  });
});

test("parses run options", () => {
  expect(parseArgs(["--live", "--context", "issue.md", "--model", "deepseek-v4-pro", "--budget", "0.25", "fix bug"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: ["issue.md"],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25,
    live: true,
    act: false
  });
});

test("parses actionable coding runs", () => {
  expect(parseArgs(["--live", "--act", "fix bug"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    live: true,
    act: true
  });
});

test("rejects --allow-read without a path", () => {
  expect(() => parseArgs(["--allow-read"])).toThrow(
    /Missing value for --allow-read/,
  );
});

test("rejects actionable writing runs", () => {
  expect(() => parseArgs(["write", "--live", "--act", "revise this"])).toThrow(/--act is only available for the coding workflow/);
});

test("parses a writing workflow task", () => {
  expect(parseArgs(["write", "--context", "draft.md", "revise this"])).toEqual({
    kind: "run",
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    model: undefined,
    budgetUsd: undefined,
    live: false,
    act: false
  });
});

test("parses non-model config set", () => {
  expect(parseArgs(["config", "set", "memoryFile", ".forgelet/memory.md"])).toEqual({
    kind: "config-set",
    key: "memoryFile",
    value: ".forgelet/memory.md"
  });
});

test("rejects config set for model defaults", () => {
  expect(() => parseArgs(["config", "set", "defaultModel", "deepseek-v4-flash"])).toThrow(/Model defaults are defined in src\/config\/index\.ts/);
  expect(() => parseArgs(["config", "set", "routing.coding.default", "deepseek-v4-flash"])).toThrow(/Model defaults are defined in src\/config\/index\.ts/);
});

test("parses memory commands", () => {
  expect(parseArgs(["memory", "suggest", "sess_123"])).toEqual({
    kind: "memory-suggest",
    sessionId: "sess_123"
  });
  expect(parseArgs(["memory", "accept", "mem_123"])).toEqual({
    kind: "memory-accept",
    suggestionId: "mem_123"
  });
});

test("rejects missing task", () => {
  expect(() => parseArgs(["--model", "deepseek-v4-pro"])).toThrow(/Usage: forge/);
});
