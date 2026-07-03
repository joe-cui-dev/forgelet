import { expect, test } from "@jest/globals";
import { parseArgs } from "../../src/cli/parseArgs.js";

test("parses a simple run task", () => {
  expect(parseArgs(["code", "fix tests"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix tests",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("parses run options", () => {
  expect(parseArgs(["code", "--preview", "--context", "issue.md", "--allow-read", "src", "--model", "deepseek-v4-pro", "--budget", "0.25", "fix bug"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: ["issue.md"],
    allowedReadPaths: ["src"],
    model: "deepseek-v4-pro",
    budgetUsd: 0.25,
    preview: true,
    act: false
  });
});

test("parses browser context commands", () => {
  expect(parseArgs(["browser", "read-current"])).toEqual({
    kind: "browser-read-current",
  });
  expect(
    parseArgs([
      "browser",
      "install-host",
      "--extension-id",
      "abcdefghijklmnopabcdefghijklmnop",
    ]),
  ).toEqual({
    kind: "browser-install-host",
    extensionId: "abcdefghijklmnopabcdefghijklmnop",
  });
  expect(parseArgs(["code", "--with-browser", "implement this issue"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "implement this issue",
    contextFiles: [],
    withBrowser: true,
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false,
  });
  expect(parseArgs(["write", "--with-browser", "turn this into an outline"])).toEqual({
    kind: "run",
    workflow: "writing",
    task: "turn this into an outline",
    contextFiles: [],
    withBrowser: true,
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false,
  });
});

test("parses actionable coding runs", () => {
  expect(parseArgs(["code", "--preview", "--act", "fix bug"])).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: true,
    act: true
  });
});

test("rejects the removed --live option", () => {
  expect(() => parseArgs(["code", "--live", "fix bug"])).toThrow(
    /Unknown option: --live/,
  );
});

test("rejects bare coding tasks and top-level run options", () => {
  expect(() => parseArgs(["fix tests"])).toThrow(/Unknown command: fix tests/);
  expect(() => parseArgs(["session", "list"])).toThrow(/Unknown command: session/);
  expect(() => parseArgs(["--preview", "fix bug"])).toThrow(
    /Unknown option: --preview/,
  );
  expect(() => parseArgs(["--act", "fix bug"])).toThrow(
    /Unknown option: --act/,
  );
});

test("parses a Session Continuation resume command", () => {
  expect(parseArgs(["resume", "sess_abc", "continue the task"])).toEqual({
    kind: "resume",
    sessionId: "sess_abc",
    instruction: "continue the task",
    act: false,
  });
});

test("parses an actionable Session Continuation resume command", () => {
  expect(parseArgs(["resume", "sess_abc", "--act", "continue the task"])).toEqual({
    kind: "resume",
    sessionId: "sess_abc",
    instruction: "continue the task",
    act: true,
  });
});

test("rejects bare Session Continuation resume", () => {
  expect(() => parseArgs(["resume", "sess_abc"])).toThrow(
    /Usage: forge resume <sessionId> \[--act\] "<instruction>"/,
  );
});

test("rejects unsupported Session Continuation shapes", () => {
  expect(() => parseArgs(["write", "resume", "sess_abc", "continue"])).toThrow(
    /Writing Workflow resume is not available yet/,
  );
  expect(() =>
    parseArgs(["resume", "sess_abc", "--reuse-context", "continue"]),
  ).toThrow(/Context reload for Session Continuation is not available yet/);
  expect(() => parseArgs(["resume", "sess_abc", "--model", "gpt-5", "continue"])).toThrow(
    /Unsupported Session Continuation option: --model/,
  );
  expect(() => parseArgs(["resume", "sess_abc", "--budget", "0.25", "continue"])).toThrow(
    /Unsupported Session Continuation option: --budget/,
  );
  expect(() => parseArgs(["resume", "sess_abc", "continue", "--act"])).toThrow(
    /Unsupported Session Continuation option: --act/,
  );
});

test("rejects --allow-read without a path", () => {
  expect(() => parseArgs(["code", "--allow-read"])).toThrow(
    /Missing value for --allow-read/,
  );
});

test("rejects run options after the task", () => {
  expect(() => parseArgs(["code", "fix bug", "--preview"])).toThrow(
    /Unknown option after task: --preview/,
  );
  expect(() =>
    parseArgs(["write", "revise this", "--context", "draft.md"]),
  ).toThrow(/Unknown option after task: --context/);
});

test("rejects actionable writing runs", () => {
  expect(() => parseArgs(["write", "--preview", "--act", "revise this"])).toThrow(/--act is only available for the coding workflow/);
});

test("parses a writing workflow task", () => {
  expect(parseArgs(["write", "--context", "draft.md", "revise this"])).toEqual({
    kind: "run",
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("parses a writing workflow preview", () => {
  expect(parseArgs(["write", "--preview", "--context", "draft.md", "revise this"])).toEqual({
    kind: "run",
    workflow: "writing",
    task: "revise this",
    contextFiles: ["draft.md"],
    model: undefined,
    budgetUsd: undefined,
    preview: true,
    act: false
  });
});

test("parses a source-backed learning workflow task", () => {
  expect(parseArgs(["learn", "--context", "paper.md", "teach me"])).toEqual({
    kind: "run",
    workflow: "learning",
    task: "teach me",
    contextFiles: ["paper.md"],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("parses a browser-backed learning workflow task", () => {
  expect(parseArgs(["learn", "--with-browser", "study this"])).toEqual({
    kind: "run",
    workflow: "learning",
    task: "study this",
    contextFiles: [],
    withBrowser: true,
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("rejects learning workflow runs without an explicit source", () => {
  expect(() => parseArgs(["learn", "teach me"])).toThrow(
    /forge learn requires --context or --with-browser/,
  );
});

test("rejects workspace read scope for learning workflow runs", () => {
  expect(() =>
    parseArgs(["learn", "--allow-read", "src", "--context", "paper.md", "teach me"]),
  ).toThrow(/--allow-read is not available for the learning workflow/);
});

test("parses a creative writing workflow variant", () => {
  expect(
    parseArgs([
      "write",
      "--creative",
      "--style",
      "vivid",
      "--context",
      "draft.md",
      "revise this scene",
    ]),
  ).toEqual({
    kind: "run",
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "revision",
    task: "revise this scene",
    contextFiles: ["draft.md"],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("parses a prompt-only creative writing workflow variant", () => {
  expect(
    parseArgs([
      "write",
      "--creative",
      "--style",
      "vivid",
      "write a rain-soaked convenience store scene",
    ]),
  ).toEqual({
    kind: "run",
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "draft",
    task: "write a rain-soaked convenience store scene",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("parses a creative writing workflow preview", () => {
  expect(
    parseArgs([
      "write",
      "--preview",
      "--creative",
      "--style",
      "vivid",
      "write a rain-soaked convenience store scene",
    ]),
  ).toEqual({
    kind: "run",
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "draft",
    task: "write a rain-soaked convenience store scene",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: true,
    act: false
  });
});

test("parses a creative Writing Artifact Continuation", () => {
  expect(
    parseArgs([
      "write",
      "--creative",
      "--style",
      "vivid",
      "--continue",
      ".forgelet/writing/chapter-1.md",
      "continue the next chapter",
    ]),
  ).toEqual({
    kind: "run",
    workflow: "writing",
    workflowVariant: "creative",
    creativeStyle: "vivid",
    creativeInputKind: "continuation",
    task: "continue the next chapter",
    contextFiles: [],
    continuationFile: ".forgelet/writing/chapter-1.md",
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false
  });
});

test("rejects misplaced Writing Artifact Continuation options", () => {
  expect(() =>
    parseArgs(["code", "--continue", "chapter-1.md", "continue the next chapter"]),
  ).toThrow(/--continue is only available for the writing workflow/);
  expect(() =>
    parseArgs(["write", "--continue", "chapter-1.md", "continue the next chapter"]),
  ).toThrow(/--continue is only available with --creative/);
});

test("rejects malformed Writing Artifact Continuation options", () => {
  expect(() =>
    parseArgs(["write", "--creative", "--style", "vivid", "--continue"]),
  ).toThrow(/Missing value for --continue/);
  expect(() =>
    parseArgs([
      "write",
      "--creative",
      "--style",
      "vivid",
      "--continue",
      "chapter-1.md",
      "--continue",
      "chapter-2.md",
      "continue",
    ]),
  ).toThrow(/Exactly one --continue artifact/);
  expect(() =>
    parseArgs([
      "write",
      "--creative",
      "--style",
      "vivid",
      "--continue",
      "chapter-1.txt",
      "continue",
    ]),
  ).toThrow(/--continue supports Markdown files only/);
});

test("rejects creative writing without a style", () => {
  expect(() =>
    parseArgs(["write", "--creative", "--context", "draft.md", "revise this"]),
  ).toThrow(/--creative requires --style/);
});

test("rejects style without creative writing", () => {
  expect(() =>
    parseArgs(["write", "--style", "vivid", "--context", "draft.md", "revise this"]),
  ).toThrow(/--style is only available with --creative/);
});

test("rejects unknown creative writing styles", () => {
  expect(() =>
    parseArgs([
      "write",
      "--creative",
      "--style",
      "noir",
      "--context",
      "draft.md",
      "revise this",
    ]),
  ).toThrow(/--style must be one of: vivid, tight, literary, plain/);
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
  expect(() => parseArgs(["code", "--model", "deepseek-v4-pro"])).toThrow(
    /Usage: forge code/,
  );
});
