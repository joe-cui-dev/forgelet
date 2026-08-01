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
