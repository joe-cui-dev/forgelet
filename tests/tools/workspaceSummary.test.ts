import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeWorkspace } from "../../src/tools/workspaceSummary.js";
import type { ToolContext } from "../../src/types.js";

test("workspace_summary detects package shape, scripts, entrypoints, and tests", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-"));
  await mkdir(join(workspaceRoot, "src", "cli"), { recursive: true });
  await mkdir(join(workspaceRoot, "tests", "unit"), { recursive: true });
  await mkdir(join(workspaceRoot, "node_modules", "ignored"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        scripts: { test: "jest", build: "tsc" },
        dependencies: { react: "^19.0.0" },
        devDependencies: { typescript: "^5.9.0" },
        bin: { forge: "./src/cli/index.ts" },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "README.md"), "# Example\n", "utf8");
  await writeFile(join(workspaceRoot, "tsconfig.json"), "{}", "utf8");
  await writeFile(join(workspaceRoot, "src", "cli", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "tests", "unit", "example.test.ts"), "test('x', () => {});\n", "utf8");
  await writeFile(join(workspaceRoot, "node_modules", "ignored", "hidden.ts"), "hidden\n", "utf8");

  const result = await summarizeWorkspace({}, testContext(workspaceRoot));
  const data = result.data as Record<string, unknown>;

  expect(result.ok).toBe(true);
  expect(data.path).toBe(".");
  expect(data.directories).toEqual(["src/", "src/cli/", "tests/", "tests/unit/"]);
  expect(data.manifests).toEqual(["package.json", "README.md"]);
  expect(data.configs).toEqual(["tsconfig.json"]);
  expect(data.scripts).toEqual({ build: "tsc", test: "jest" });
  expect(data.dependencies).toEqual(["react", "typescript"]);
  expect(data.entrypointCandidates).toEqual(["src/cli/index.ts"]);
  expect(data.testConventions).toEqual(["tests/", "*.test.ts"]);
  expect(data.skippedDirectories).toEqual(["node_modules/"]);
  expect(data.content).toEqual(expect.stringContaining("## Scripts and dependencies"));
});

test("workspace_summary obeys Session Read Scope and path narrowing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-scope-"));
  await mkdir(join(workspaceRoot, "src", "cli"), { recursive: true });
  await mkdir(join(workspaceRoot, "tests"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "cli", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "tests", "secret.test.ts"), "secret\n", "utf8");

  const scoped = await summarizeWorkspace({}, testContext(workspaceRoot, ["src"]));
  const scopedData = scoped.data as Record<string, unknown>;
  expect(scopedData.scopeConstrained).toBe(true);
  expect(scopedData.directories).toEqual(["src/", "src/cli/"]);
  expect(scopedData.entrypointCandidates).toEqual(["src/cli/index.ts"]);
  expect(scopedData.testConventions).toEqual([]);

  const narrowed = await summarizeWorkspace(
    { path: "src/cli" },
    testContext(workspaceRoot, ["src"]),
  );
  const narrowedData = narrowed.data as Record<string, unknown>;
  expect(narrowedData.path).toBe("src/cli");
  expect(narrowedData.directories).toEqual([]);
  expect(narrowedData.entrypointCandidates).toEqual(["src/cli/index.ts"]);
});

test("workspace_summary resolves manifest signals relative to a narrowed path", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-summary-package-path-"),
  );
  await mkdir(join(workspaceRoot, "packages", "app", "src"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "packages", "app", "package.json"),
    JSON.stringify(
      {
        scripts: { test: "vitest" },
        dependencies: { zod: "^4.0.0" },
        main: "./src/index.ts",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, "packages", "app", "src", "index.ts"),
    "export {};\n",
    "utf8",
  );

  const result = await summarizeWorkspace(
    { path: "packages/app" },
    testContext(workspaceRoot),
  );
  const data = result.data as Record<string, unknown>;

  expect(data.manifests).toEqual(["packages/app/package.json"]);
  expect(data.scripts).toEqual({ test: "vitest" });
  expect(data.dependencies).toEqual(["zod"]);
  expect(data.entrypointCandidates).toEqual(["packages/app/src/index.ts"]);
});

test("workspace_summary returns bounded high-signal excerpts with truncation metadata", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-excerpts-"));
  await mkdir(join(workspaceRoot, "src", "cli"), { recursive: true });
  await writeFile(join(workspaceRoot, "README.md"), "1234567890abcdef\n", "utf8");
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "jest" } }, null, 2),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "cli", "index.ts"), "console.log('hi');\n", "utf8");

  const result = await summarizeWorkspace(
    { maxExcerptBytes: 8 },
    testContext(workspaceRoot),
  );
  const data = result.data as Record<string, unknown>;
  const excerpts = data.excerpts as Record<string, unknown>[];

  expect(excerpts.map((excerpt) => excerpt.path)).toEqual([
    "README.md",
    "package.json",
    "tsconfig.json",
    "src/cli/index.ts",
  ]);
  expect(excerpts[0]).toMatchObject({
    path: "README.md",
    returnedBytes: 8,
    totalBytes: 17,
    truncated: true,
    content: "12345678",
  });
  expect(data.content).toEqual(expect.stringContaining("## High-signal excerpts"));
  expect(data.content).toEqual(expect.stringContaining("- Truncated excerpts: README.md"));
});

const testContext = (
  workspaceRoot: string,
  readScope?: string[],
): ToolContext => ({
  workspaceRoot,
  sessionId: "sess_test",
  workflow: "coding",
  grantedCapabilities: ["read_workspace"],
  readScope,
});
