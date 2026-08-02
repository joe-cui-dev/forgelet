import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadOnlyTools } from "../../src/tools/readOnly.js";
import type { ToolContext } from "../../src/types.js";

test("search_text searches a single file when path names a file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-search-file-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "const needle = 1;\nconst other = 2;\n",
    "utf8",
  );

  const searchText = findSearchTextTool();
  const result = await searchText.execute(
    { query: "needle", path: "example.ts" },
    testContext(workspaceRoot),
  );

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    content: "example.ts:1: const needle = 1;",
  });
});

test("search_text searches recursively when path names a directory", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-search-dir-"));
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "src", "example.ts"),
    "const needle = 1;\nconst other = 2;\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "outside.ts"),
    "const needle = 2;\n",
    "utf8",
  );

  const searchText = findSearchTextTool();
  const result = await searchText.execute(
    { query: "needle", path: "src" },
    testContext(workspaceRoot),
  );

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    content: "src/example.ts:1: const needle = 1;",
  });
});

test("search_text reports a clear error for a path that does not exist", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-search-missing-"));

  const searchText = findSearchTextTool();

  await expect(
    searchText.execute(
      { query: "needle", path: "does/not/exist.ts" },
      testContext(workspaceRoot),
    ),
  ).rejects.toThrow("Path does not exist in workspace: does/not/exist.ts");
});

test("list_files skips nested worktrees without hiding the rest of .claude", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-list-worktrees-"));
  await mkdir(join(workspaceRoot, ".claude", "skills"), { recursive: true });
  await mkdir(join(workspaceRoot, ".claude", "worktrees", "copy", "src"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(
    join(workspaceRoot, ".claude", "skills", "verify.md"),
    "# Verify\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".claude", "worktrees", "copy", "src", "index.ts"),
    "export {};\n",
    "utf8",
  );

  const listFiles = findReadOnlyTool("list_files");
  const result = await listFiles.execute({}, testContext(workspaceRoot));

  expect(result.ok).toBe(true);
  expect(result.summary).toBe("Listed 2 files.");
  expect(result.data).toMatchObject({
    content: [".claude/skills/verify.md", "src/index.ts"].join("\n"),
  });
});

test("read_file truncates at the Route's observation limit and states it", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-read-limit-"));
  const content = "x".repeat(30 * 1024);
  await writeFile(join(workspaceRoot, "big.txt"), content, "utf8");

  const atDefault = findReadFileTool();
  const defaultResult = await atDefault.execute(
    { path: "big.txt" },
    testContext(workspaceRoot),
  );

  expect(defaultResult.data).toMatchObject({
    truncated: true,
    returnedBytes: 20 * 1024,
  });
  expect(atDefault.description).toContain("20480-byte");

  const atCodingBudget = findReadFileTool(64 * 1024);
  const wideResult = await atCodingBudget.execute(
    { path: "big.txt" },
    testContext(workspaceRoot),
  );

  expect(wideResult.data).toMatchObject({
    truncated: false,
    returnedBytes: 30 * 1024,
  });
  expect(atCodingBudget.description).toContain("65536-byte");
});

test("naming an internal directory directly is forbidden for every read tool", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-read-internal-"));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  await mkdir(join(workspaceRoot, ".git", "logs"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_prior.jsonl"),
    '{"type":"user_task"}\n',
    "utf8",
  );
  await writeFile(join(workspaceRoot, ".git", "logs", "HEAD"), "ref\n", "utf8");

  const ctx = testContext(workspaceRoot);
  const denials = await Promise.all([
    findReadFileTool().classify?.({ path: ".git/logs/HEAD" }, ctx),
    findReadOnlyTool("list_files").classify?.(
      { path: ".forgelet/sessions" },
      ctx,
    ),
    findSearchTextTool().classify?.(
      { query: "V4 Flash", path: ".forgelet/sessions" },
      ctx,
    ),
    findReadOnlyTool("workspace_summary").classify?.({ path: ".forgelet" }, ctx),
  ]);

  for (const denial of denials) {
    expect(denial?.riskTier).toBe("forbidden");
    expect(denial?.targets?.[0]).toMatchObject({ classification: "internal" });
  }
});

test("an explicit Session Read Scope entry unlocks the internal path it names", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-read-granted-"));
  await mkdir(join(workspaceRoot, ".forgelet", "sessions"), { recursive: true });
  await mkdir(join(workspaceRoot, ".forgelet", "debug"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "sessions", "sess_prior.jsonl"),
    '{"type":"user_task"}\n',
    "utf8",
  );

  const granted = testContext(workspaceRoot, [".forgelet/sessions"]);

  const allowed = await findReadFileTool().classify?.(
    { path: ".forgelet/sessions/sess_prior.jsonl" },
    granted,
  );
  expect(allowed?.riskTier).toBe("low");
  expect(allowed?.targets?.[0]).toMatchObject({ classification: "ordinary" });

  // The grant reaches exactly the directory it named, not the rest of .forgelet.
  const sibling = await findReadOnlyTool("list_files").classify?.(
    { path: ".forgelet/debug" },
    granted,
  );
  expect(sibling?.riskTier).toBe("forbidden");
});

test("naming a credential file directly is forbidden for every read tool", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-read-secret-"));
  await mkdir(join(workspaceRoot, "deploy"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".env"),
    "DEEPSEEK_API_KEY=sk-live-secret\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "deploy", "server.pem"), "key\n", "utf8");

  const ctx = testContext(workspaceRoot);
  const denials = await Promise.all([
    findReadFileTool().classify?.({ path: ".env" }, ctx),
    findReadFileTool().classify?.({ path: "deploy/server.pem" }, ctx),
    findSearchTextTool().classify?.({ query: "KEY", path: ".env" }, ctx),
    findReadOnlyTool("workspace_summary").classify?.({ path: ".env" }, ctx),
  ]);

  for (const denial of denials) {
    expect(denial?.riskTier).toBe("forbidden");
    expect(denial?.targets?.[0]).toMatchObject({ classification: "sensitive" });
  }
});

test("a workspace-wide search never walks into a credential file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-search-secret-"));
  await writeFile(
    join(workspaceRoot, ".env"),
    "DEEPSEEK_API_KEY=sk-live-secret\nDEEPSEEK_MODEL=deepseek-v4-flash\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".env.example"),
    "DEEPSEEK_API_KEY=replace_me\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "README.md"),
    "Set DEEPSEEK_API_KEY before running.\n",
    "utf8",
  );

  // Nobody names `.env` as a read target; a search walks past it. That is how
  // a live key reached a Session's conversation and its Trace.
  const result = await findSearchTextTool().execute(
    { query: "DEEPSEEK_API_KEY" },
    testContext(workspaceRoot),
  );

  expect(result.ok).toBe(true);
  const content = String((result.data as { content: string }).content);
  expect(content).not.toContain("sk-live-secret");
  expect(content).not.toContain(".env:");
  // The template still answers "which variables does this workspace need".
  expect(content).toContain(".env.example:1: DEEPSEEK_API_KEY=replace_me");
  expect(content).toContain("README.md:1:");
});

test("an explicit Session Read Scope entry unlocks the credential file it names", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-secret-granted-"));
  await writeFile(
    join(workspaceRoot, ".env"),
    "DEEPSEEK_API_KEY=sk-live-secret\n",
    "utf8",
  );
  await writeFile(join(workspaceRoot, "server.pem"), "key\n", "utf8");

  const granted = testContext(workspaceRoot, [".env"]);
  const allowed = await findReadFileTool().classify?.({ path: ".env" }, granted);
  expect(allowed?.riskTier).toBe("low");
  expect(allowed?.targets?.[0]).toMatchObject({ classification: "ordinary" });

  // The grant reaches exactly the file it named, not credentials in general.
  const sibling = await findReadFileTool().classify?.(
    { path: "server.pem" },
    granted,
  );
  expect(sibling?.riskTier).toBe("forbidden");

  // And a scope that merely contains the workspace does not grant it.
  const wide = await findReadFileTool().classify?.(
    { path: ".env" },
    testContext(workspaceRoot, ["."]),
  );
  expect(wide?.riskTier).toBe("forbidden");
});

test("ordinary workspace reads stay low-risk beside the internal boundary", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-read-ordinary-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");

  const ctx = testContext(workspaceRoot);

  const read = await findReadFileTool().classify?.({ path: "src/index.ts" }, ctx);
  expect(read?.riskTier).toBe("low");

  // The default root still lists the workspace; traversal skips .forgelet.
  const listed = await findReadOnlyTool("list_files").classify?.({}, ctx);
  expect(listed?.riskTier).toBe("low");
});

function findReadFileTool(maxObservationBytes?: number) {
  const tools = createReadOnlyTools({ items: [] }, maxObservationBytes);
  const tool = tools.find((candidate) => candidate.name === "read_file");
  if (!tool) throw new Error("read_file tool is not registered.");
  return tool;
}

function findSearchTextTool() {
  return findReadOnlyTool("search_text");
}

function findReadOnlyTool(name: string) {
  const tools = createReadOnlyTools({ items: [] });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool is not registered.`);
  return tool;
}

function testContext(
  workspaceRoot: string,
  readScope?: string[],
): ToolContext {
  return {
    workspaceRoot,
    sessionId: "sess_test",
    workflow: "coding",
    grantedCapabilities: ["read_workspace"],
    readScope,
  };
}
