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

function findSearchTextTool() {
  const tools = createReadOnlyTools({ items: [] });
  const tool = tools.find((candidate) => candidate.name === "search_text");
  if (!tool) throw new Error("search_text tool is not registered.");
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
