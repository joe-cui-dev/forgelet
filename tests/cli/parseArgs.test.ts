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

test("parses Debug Transcript flags for model-backed Session commands", () => {
  expect(parseArgs(["code", "--debug", "inspect"])).toMatchObject({
    kind: "run",
    workflow: "coding",
    debug: true,
  });
  expect(parseArgs(["write", "--debug", "revise this"])).toMatchObject({
    kind: "run",
    workflow: "writing",
    debug: true,
  });
  expect(parseArgs(["learn", "--debug", "--context", "paper.md", "teach me"])).toMatchObject({
    kind: "run",
    workflow: "learning",
    debug: true,
  });
  expect(parseArgs(["resume", "sess_abc", "--debug", "continue the task"])).toEqual({
    kind: "resume",
    sessionId: "sess_abc",
    instruction: "continue the task",
    act: false,
    debug: true,
  });
});

test("rejects Debug Transcript flags for previews", () => {
  expect(() => parseArgs(["code", "--preview", "--debug", "inspect"])).toThrow(
    /--debug is available only for model-backed Session runs, not --preview/,
  );
});

test("parses Debug Transcript viewer commands", () => {
  expect(parseArgs(["debug", "show", "sess_1"])).toEqual({
    kind: "debug-show",
    sessionId: "sess_1",
    full: false,
  });
  expect(parseArgs(["debug", "show", "sess_1", "--full"])).toEqual({
    kind: "debug-show",
    sessionId: "sess_1",
    full: true,
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

test("parses browser workspace profile commands", () => {
  expect(parseArgs(["browser", "profiles", "approve"])).toEqual({
    kind: "browser-profiles-approve",
  });
  expect(
    parseArgs(["browser", "profiles", "approve", "--name", "My Repo"]),
  ).toEqual({
    kind: "browser-profiles-approve",
    name: "My Repo",
  });
  expect(parseArgs(["browser", "profiles", "list"])).toEqual({
    kind: "browser-profiles-list",
  });
  expect(
    parseArgs(["browser", "profiles", "set-default", "profile_123"]),
  ).toEqual({
    kind: "browser-profiles-set-default",
    profileId: "profile_123",
  });
  expect(
    parseArgs(["browser", "profiles", "revoke", "profile_123"]),
  ).toEqual({
    kind: "browser-profiles-revoke",
    profileId: "profile_123",
  });
});

test("rejects malformed browser workspace profile commands", () => {
  expect(() => parseArgs(["browser", "profiles"])).toThrow(
    /Usage: forge browser profiles/,
  );
  expect(() => parseArgs(["browser", "profiles", "set-default"])).toThrow(
    /Usage: forge browser profiles/,
  );
  expect(() =>
    parseArgs(["browser", "profiles", "approve", "--bogus"]),
  ).toThrow(/Usage: forge browser profiles/);
});

test("parses project Knowledge Note creation", () => {
  expect(
    parseArgs(["notes", "create", "--scope", "project", "--from-session", "sess_123"]),
  ).toEqual({
    kind: "notes-create",
    scope: "project",
    fromSessionId: "sess_123",
    title: undefined,
  });
});

test("parses project Knowledge Notes search", () => {
  expect(
    parseArgs(["notes", "search", "--scope", "project", "--limit", "5", "workflow graph"]),
  ).toEqual({
    kind: "notes-search",
    scope: "project",
    query: "workflow graph",
    limit: 5,
  });
});

test("rejects unsupported Knowledge Notes command shapes clearly", () => {
  expect(() =>
    parseArgs(["notes", "create", "--scope", "personal", "--from-session", "sess_123"]),
  ).toThrow(/Personal Knowledge Scope is not available yet/);
  expect(() => parseArgs(["notes", "create", "--scope", "project"])).toThrow(
    /forge notes create --scope project --from-session <sessionId> \[--title <title>\]/,
  );
  expect(() => parseArgs(["notes", "search", "--scope", "project"])).toThrow(
    /forge notes search --scope project \[--limit <n>\] "<query>"/,
  );
  expect(() =>
    parseArgs(["notes", "search", "--scope", "project", "--limit", "0", "query"]),
  ).toThrow(/--limit must be a positive integer/);
  expect(() =>
    parseArgs(["notes", "search", "--scope", "project", "--json", "query"]),
  ).toThrow(/JSON output is not available yet/);
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

test("parses a background coding run declaring an Effect Envelope write scope", () => {
  expect(
    parseArgs(["code", "--write-scope", "src", "--write-scope", "docs", "fix bug"]),
  ).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: true,
    writeScopePrefixes: ["src", "docs"],
  });
});

test("parses a write scope of '.' and a narrowed command allowlist", () => {
  expect(
    parseArgs([
      "code",
      "--write-scope",
      ".",
      "--allow-command",
      "npm test",
      "--allow-command",
      "npm run build",
      "fix bug",
    ]),
  ).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: true,
    writeScopePrefixes: ["."],
    allowedCommands: ["npm test", "npm run build"],
  });
});

test("parses wall-clock and turn ceiling overrides", () => {
  expect(
    parseArgs([
      "code",
      "--act",
      "--max-wall-clock-ms",
      "600000",
      "--max-turns",
      "20",
      "fix bug",
    ]),
  ).toEqual({
    kind: "run",
    workflow: "coding",
    task: "fix bug",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: true,
    maxWallClockMs: 600_000,
    maxModelTurns: 20,
  });
});

test("rejects --allow-command without a preceding --write-scope", () => {
  expect(() => parseArgs(["code", "--allow-command", "npm test", "fix bug"])).toThrow(
    /--allow-command requires --write-scope/,
  );
});

test("rejects --write-scope and --allow-command for non-coding workflows", () => {
  expect(() => parseArgs(["write", "--write-scope", "src", "revise this"])).toThrow(
    /--write-scope is only available for the coding workflow/,
  );
});

test("rejects invalid wall-clock and turn ceiling overrides", () => {
  expect(() => parseArgs(["code", "--act", "--max-wall-clock-ms", "0", "fix bug"])).toThrow(
    /--max-wall-clock-ms must be a positive integer/,
  );
  expect(() => parseArgs(["code", "--act", "--max-turns", "0", "fix bug"])).toThrow(
    /--max-turns must be a positive integer/,
  );
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

test("parses the Decision Queue command", () => {
  expect(parseArgs(["queue"])).toEqual({ kind: "queue" });
});

test("rejects extra Decision Queue arguments", () => {
  expect(() => parseArgs(["queue", "extra"])).toThrow(/Usage: forge queue/);
});

test("parses a forge decide command with and without a session id", () => {
  expect(parseArgs(["decide"])).toEqual({ kind: "decide" });
  expect(parseArgs(["decide", "sess_abc"])).toEqual({
    kind: "decide",
    sessionId: "sess_abc",
  });
});

test("rejects extra forge decide arguments", () => {
  expect(() => parseArgs(["decide", "sess_abc", "extra"])).toThrow(
    /Usage: forge decide \[sessionId\]/,
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

test("parses all built-in creative Style Presets", () => {
  const styles = [
    "plain",
    "vivid",
    "tight",
    "literary",
    "cinematic",
    "minimal",
    "lyrical",
    "noir",
    "warm",
    "sharp",
    "sensual",
    "ardent",
  ];

  for (const style of styles) {
    expect(
      parseArgs([
        "write",
        "--creative",
        "--style",
        style,
        "write a rain-soaked convenience store scene",
      ]),
    ).toMatchObject({
      kind: "run",
      workflow: "writing",
      workflowVariant: "creative",
      creativeStyle: style,
      creativeInputKind: "draft",
    });
  }
});

test("parses Writing Artifact Catalog commands", () => {
  expect(parseArgs(["write", "artifacts", "list"])).toEqual({
    kind: "writing-artifacts-list",
  });
  expect(
    parseArgs(["write", "artifacts", "show", ".forgelet/writing/chapter-1.md"]),
  ).toEqual({
    kind: "writing-artifacts-show",
    artifact: ".forgelet/writing/chapter-1.md",
    full: false,
  });
  expect(parseArgs(["write", "artifacts", "show", "sess_abc", "--full"])).toEqual({
    kind: "writing-artifacts-show",
    artifact: "sess_abc",
    full: true,
  });
  expect(parseArgs(["write", "artifacts", "search", "rain"])).toEqual({
    kind: "writing-artifacts-search",
    query: "rain",
    limit: 10,
  });
  expect(
    parseArgs(["write", "artifacts", "search", "--limit", "5", "chapter"]),
  ).toEqual({
    kind: "writing-artifacts-search",
    query: "chapter",
    limit: 5,
  });
});

test("parses Writing Project create commands", () => {
  expect(parseArgs(["write", "projects", "create", "my-novel"])).toEqual({
    kind: "writing-projects-create",
    slug: "my-novel",
  });
});

test("parses Writing Project runs", () => {
  expect(parseArgs(["write", "--project", "my-novel", "write chapter eleven"])).toEqual({
    kind: "run",
    workflow: "writing",
    projectSlug: "my-novel",
    task: "write chapter eleven",
    contextFiles: [],
    model: undefined,
    budgetUsd: undefined,
    preview: false,
    act: false,
  });
});

test("parses Writing Project runs with an explicit member continuation source", () => {
  expect(
    parseArgs([
      "write",
      "--project",
      "my-novel",
      "--creative",
      "--style",
      "vivid",
      "--continue",
      ".forgelet/writing/chapter-1.md",
      "revise chapter one",
    ]),
  ).toMatchObject({
    kind: "run",
    workflow: "writing",
    projectSlug: "my-novel",
    continuationFile: ".forgelet/writing/chapter-1.md",
    creativeInputKind: "continuation",
  });
});

test("rejects malformed Writing Project run options", () => {
  expect(() => parseArgs(["write", "--project"])).toThrow(
    /Missing value for --project/,
  );
  expect(() =>
    parseArgs([
      "write",
      "--project",
      "my-novel",
      "--project",
      "other-novel",
      "write",
    ]),
  ).toThrow(/Exactly one --project slug can be provided/);
  expect(() => parseArgs(["code", "--project", "my-novel", "inspect"])).toThrow(
    /--project is only available for the writing workflow/,
  );
  expect(() =>
    parseArgs(["learn", "--project", "my-novel", "--context", "paper.md", "study"]),
  ).toThrow(/--project is only available for the writing workflow/);
  expect(() => parseArgs(["write", "write", "--project", "my-novel"])).toThrow(
    /Unknown option after task: --project/,
  );
});

test("rejects malformed Writing Project commands", () => {
  expect(() => parseArgs(["write", "projects", "create"])).toThrow(
    /forge write projects create <slug>/,
  );
  expect(() =>
    parseArgs(["write", "projects", "create", "my-novel", "extra"]),
  ).toThrow(/forge write projects create <slug>/);
  expect(() => parseArgs(["write", "projects", "list"])).toThrow(
    /forge write projects create <slug>/,
  );
});

test("rejects malformed Writing Artifact Catalog search commands", () => {
  expect(() => parseArgs(["write", "artifacts", "search"])).toThrow(
    /forge write artifacts search \[--limit <n>\] "<query>"/,
  );
  expect(() => parseArgs(["write", "artifacts", "search", "   "])).toThrow(
    /forge write artifacts search \[--limit <n>\] "<query>"/,
  );
  expect(() =>
    parseArgs(["write", "artifacts", "search", "--limit", "0", "rain"]),
  ).toThrow(/--limit must be a positive integer/);
  expect(() =>
    parseArgs(["write", "artifacts", "search", "rain", "--limit", "5"]),
  ).toThrow(/Unsupported Writing Artifact Catalog option after query: --limit/);
  expect(() =>
    parseArgs(["write", "artifacts", "search", "--json", "rain"]),
  ).toThrow(/Unsupported Writing Artifact Catalog option: --json/);
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
  ).toThrow(
    /--creative requires --style <plain, vivid, tight, literary, cinematic, minimal, lyrical, noir, warm, sharp, sensual, ardent>/,
  );
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
      "gothic",
      "--context",
      "draft.md",
      "revise this",
    ]),
  ).toThrow(
    /--style must be one of: plain, vivid, tight, literary, cinematic, minimal, lyrical, noir, warm, sharp, sensual, ardent/,
  );
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
  expect(parseArgs(["memory", "show", "mem_123"])).toEqual({
    kind: "memory-show",
    suggestionId: "mem_123"
  });
  expect(parseArgs(["memory", "suggest", "sess_123"])).toEqual({
    kind: "memory-suggest",
    sessionId: "sess_123"
  });
  expect(parseArgs(["memory", "accept", "mem_123"])).toEqual({
    kind: "memory-accept",
    suggestionId: "mem_123"
  });
  expect(parseArgs(["memory", "list"])).toEqual({
    kind: "memory-list",
    all: false
  });
  expect(parseArgs(["memory", "list", "--all"])).toEqual({
    kind: "memory-list",
    all: true
  });
  expect(() => parseArgs(["memory", "list", "--json"])).toThrow(
    /Usage: forge memory list/,
  );
});

test("rejects missing task", () => {
  expect(() => parseArgs(["code", "--model", "deepseek-v4-pro"])).toThrow(
    /Usage: forge code/,
  );
});
