import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectAnchorFiles,
  summarizeWorkspace,
} from "../../src/tools/workspaceSummary.js";
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
  expect(data.anchorFiles).toEqual(["package.json", "README.md"]);
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

test("workspace_summary resolves anchor signals relative to a narrowed path", async () => {
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

  expect(data.anchorFiles).toEqual(["packages/app/package.json"]);
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
    "package.json",
    "README.md",
    "src/cli/index.ts",
    "tsconfig.json",
  ]);
  expect(excerpts.find((excerpt) => excerpt.path === "README.md")).toMatchObject({
    path: "README.md",
    returnedBytes: 8,
    totalBytes: 17,
    truncated: true,
    content: "12345678",
  });
  expect(data.content).toEqual(expect.stringContaining("## High-signal excerpts"));
  expect(data.content).toEqual(
    expect.stringContaining(
      "- Truncated excerpts: package.json, README.md, src/cli/index.ts",
    ),
  );
});

test("workspace_summary keeps anchor files even when truncation excludes them", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-anchor-trunc-"));
  // Filler sorts after README.md ("R") but before package.json ("p"), so a tiny
  // maxFiles slice keeps README.md yet drops package.json past the truncation line.
  await writeFile(join(workspaceRoot, "a1.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "a2.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "a3.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "README.md"), "# Example\n", "utf8");
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { build: "tsc" }, dependencies: { zod: "^4.0.0" } }, null, 2),
    "utf8",
  );

  const result = await summarizeWorkspace({ maxFiles: 2 }, testContext(workspaceRoot));
  const data = result.data as Record<string, unknown>;
  const limits = data.limits as Record<string, unknown>;

  expect(data.anchorFiles).toEqual(["package.json", "README.md"]);
  expect(data.scripts).toEqual({ build: "tsc" });
  expect(data.dependencies).toEqual(["zod"]);
  expect(limits.scannedFiles).toBe(3);
});

test("workspace_summary unions all anchors under an explicit tiny maxFiles", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-tiny-max-"));
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "jest" } }, null, 2),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "README.md"), "# R\n", "utf8");
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# A\n", "utf8");
  await writeFile(join(workspaceRoot, "CONTEXT.md"), "# C\n", "utf8");

  const result = await summarizeWorkspace({ maxFiles: 1 }, testContext(workspaceRoot));
  const data = result.data as Record<string, unknown>;
  const excerpts = data.excerpts as Record<string, unknown>[];

  expect(data.anchorFiles).toEqual([
    "package.json",
    "README.md",
    "AGENTS.md",
    "CONTEXT.md",
  ]);
  expect(excerpts.map((excerpt) => excerpt.path)).toEqual([
    "package.json",
    "README.md",
    "AGENTS.md",
    "CONTEXT.md",
  ]);
});

test("workspace_summary anchors only the effective scan root, not nested packages", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-monorepo-"));
  await mkdir(join(workspaceRoot, "packages", "app"), { recursive: true });
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({}, null, 2), "utf8");
  await writeFile(join(workspaceRoot, "README.md"), "# root\n", "utf8");
  await writeFile(
    join(workspaceRoot, "packages", "app", "package.json"),
    JSON.stringify({ name: "app" }, null, 2),
    "utf8",
  );

  const fromRoot = await summarizeWorkspace({}, testContext(workspaceRoot));
  const rootData = fromRoot.data as Record<string, unknown>;
  expect(rootData.anchorFiles).toEqual(["package.json", "README.md"]);
  expect(rootData.anchorFiles).not.toContain("packages/app/package.json");

  const fromPackage = await summarizeWorkspace(
    { path: "packages/app" },
    testContext(workspaceRoot),
  );
  const packageData = fromPackage.data as Record<string, unknown>;
  expect(packageData.anchorFiles).toEqual(["packages/app/package.json"]);
});

test("workspace_summary renders the anchor header and reports anchors beyond max files", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-render-"));
  await writeFile(join(workspaceRoot, "a1.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "a2.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "a3.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "README.md"), "# R\n", "utf8");
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({}, null, 2), "utf8");

  const truncated = await summarizeWorkspace({ maxFiles: 2 }, testContext(workspaceRoot));
  const truncatedContent = (truncated.data as Record<string, unknown>).content as string;
  expect(truncatedContent).toContain("- Anchor Files: package.json, README.md");
  expect(truncatedContent).toContain("- Anchor files scanned beyond max files: 1");

  const full = await summarizeWorkspace({}, testContext(workspaceRoot));
  const fullContent = (full.data as Record<string, unknown>).content as string;
  expect(fullContent).toContain("- Anchor Files: package.json, README.md");
  expect(fullContent).not.toContain("Anchor files scanned beyond max files");
});

test("workspace_summary renders an anchor header even when no anchors exist", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-no-anchor-"));
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");

  const result = await summarizeWorkspace({}, testContext(workspaceRoot));
  const content = (result.data as Record<string, unknown>).content as string;
  expect(content).toContain("- Anchor Files: none");
});

test("workspace_summary caps excerpts at four anchors plus one non-anchor slot", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-budget-"));
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await mkdir(join(workspaceRoot, "tests"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "jest" } }, null, 2),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "README.md"), "# R\n", "utf8");
  await writeFile(join(workspaceRoot, "AGENTS.md"), "# A\n", "utf8");
  await writeFile(join(workspaceRoot, "CONTEXT.md"), "# C\n", "utf8");
  await writeFile(join(workspaceRoot, "tsconfig.json"), "{}\n", "utf8");
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "tests", "x.test.ts"), "test('x', () => {});\n", "utf8");

  const result = await summarizeWorkspace({}, testContext(workspaceRoot));
  const data = result.data as Record<string, unknown>;
  const excerpts = data.excerpts as Record<string, unknown>[];

  expect(excerpts.map((excerpt) => excerpt.path)).toEqual([
    "package.json",
    "README.md",
    "AGENTS.md",
    "CONTEXT.md",
    "src/index.ts",
  ]);
});

test("workspace_summary verifies an anchored entrypoint against the full listing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-entry-full-"));
  await writeFile(join(workspaceRoot, "a1.ts"), "export {};\n", "utf8");
  await writeFile(join(workspaceRoot, "a2.ts"), "export {};\n", "utf8");
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ main: "./z_entry.ts" }, null, 2),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "tsconfig.build.json"), "{}\n", "utf8");
  await writeFile(join(workspaceRoot, "z_entry.ts"), "export {};\n", "utf8");

  const result = await summarizeWorkspace({ maxFiles: 2 }, testContext(workspaceRoot));
  const data = result.data as Record<string, unknown>;
  const excerpts = data.excerpts as Record<string, unknown>[];

  // main points past the alphabetical truncation line but still resolves on the full list.
  expect(data.entrypointCandidates).toEqual(["z_entry.ts"]);
  expect(excerpts.map((excerpt) => excerpt.path)).toContain("z_entry.ts");
  // Config detection stays on the truncated slice, so the beyond-slice tsconfig is unlisted.
  expect(data.configs).toEqual([]);
});

test("workspace_summary never surfaces an anchor outside Session Read Scope", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-summary-anchor-scope-"));
  await mkdir(join(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    join(workspaceRoot, "package.json"),
    JSON.stringify({ scripts: { test: "jest" }, dependencies: { zod: "^4.0.0" } }, null, 2),
    "utf8",
  );
  await writeFile(join(workspaceRoot, "src", "index.ts"), "export {};\n", "utf8");

  const result = await summarizeWorkspace({}, testContext(workspaceRoot, ["src"]));
  const data = result.data as Record<string, unknown>;
  const excerpts = data.excerpts as Record<string, unknown>[];

  expect(data.anchorFiles).toEqual([]);
  expect(data.scripts).toEqual({});
  expect(data.dependencies).toEqual([]);
  expect(excerpts.map((excerpt) => excerpt.path)).not.toContain("package.json");
  expect(data.content).not.toContain("package.json");
});

test("selectAnchorFiles matches names case-insensitively at the scan root", () => {
  expect(
    selectAnchorFiles(["Readme.md", "Package.json", "src/README.md"], "."),
  ).toEqual(["Package.json", "Readme.md"]);
});

test("selectAnchorFiles breaks casing ties by byte-order-smallest path", () => {
  // Cannot be built on a case-insensitive filesystem (macOS dev machines), so the
  // coexisting-casing case is exercised in memory here.
  expect(selectAnchorFiles(["Readme.md", "README.md", "readme.md"], ".")).toEqual([
    "README.md",
  ]);
});

test("selectAnchorFiles ignores nested same-named files", () => {
  expect(
    selectAnchorFiles(["packages/app/package.json"], "."),
  ).toEqual([]);
  expect(
    selectAnchorFiles(["packages/app/package.json"], "packages/app"),
  ).toEqual(["packages/app/package.json"]);
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
