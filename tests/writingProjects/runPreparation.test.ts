import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@jest/globals";
import {
  prepareWritingProjectRun,
  type WritingProjectManifest,
} from "../../src/writingProjects/index.js";

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-writing-run-"));
}

function manifest(overrides: Partial<WritingProjectManifest> = {}): WritingProjectManifest {
  return {
    slug: "my-novel",
    createdAt: "2026-01-01T00:00:00.000Z",
    head: null,
    members: [],
    ...overrides,
  };
}

test("rejects --project combined with --allow-read", async () => {
  const workspaceRoot = await makeWorkspace();

  await expect(
    prepareWritingProjectRun({
      workspaceRoot,
      project: manifest(),
      allowedReadPaths: ["src"],
    }),
  ).rejects.toThrow(
    "--project cannot be combined with --allow-read; the Writing Project manifest defines the Session Read Scope.",
  );
});

test("throws when the Writing Project head is missing from disk", async () => {
  const workspaceRoot = await makeWorkspace();

  await expect(
    prepareWritingProjectRun({
      workspaceRoot,
      project: manifest({
        head: ".forgelet/writing/head.md",
        members: [".forgelet/writing/head.md"],
      }),
    }),
  ).rejects.toThrow(
    "Writing Project head is missing: .forgelet/writing/head.md. Edit .forgelet/writing/projects/my-novel.json or restore the artifact before continuing.",
  );
});

test("warns and excludes a missing non-head member, keeping existing members", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "head.md"),
    "content",
    "utf8",
  );

  const result = await prepareWritingProjectRun({
    workspaceRoot,
    project: manifest({
      head: ".forgelet/writing/head.md",
      members: [".forgelet/writing/missing.md", ".forgelet/writing/head.md"],
    }),
  });

  expect(result.readScopeMembers).toEqual([".forgelet/writing/head.md"]);
  expect(result.warnings).toEqual([
    "Warning: Writing Project member is missing and was excluded from this Session Read Scope: .forgelet/writing/missing.md",
  ]);
});

test("defaults continuationFile to the project head when --continue is not given", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "head.md"),
    "content",
    "utf8",
  );

  const result = await prepareWritingProjectRun({
    workspaceRoot,
    project: manifest({
      head: ".forgelet/writing/head.md",
      members: [".forgelet/writing/head.md"],
    }),
  });

  expect(result.continuationFile).toBe(".forgelet/writing/head.md");
});

test("rejects --continue when it is not a member of the Writing Project", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "head.md"),
    "content",
    "utf8",
  );

  await expect(
    prepareWritingProjectRun({
      workspaceRoot,
      project: manifest({
        head: ".forgelet/writing/head.md",
        members: [".forgelet/writing/head.md"],
      }),
      continuationFile: ".forgelet/writing/other.md",
    }),
  ).rejects.toThrow(
    [
      "--continue artifact is not a member of Writing Project my-novel: .forgelet/writing/other.md",
      "Remove --project to continue it directly, or edit .forgelet/writing/projects/my-novel.json to add the member.",
    ].join("\n"),
  );
});

test("order: --project/--allow-read conflict fires before continuation resolution errors", async () => {
  const workspaceRoot = await makeWorkspace();

  await expect(
    prepareWritingProjectRun({
      workspaceRoot,
      project: manifest({
        head: ".forgelet/writing/head.md",
        members: [".forgelet/writing/head.md"],
      }),
      allowedReadPaths: ["src"],
      continuationFile: ".forgelet/writing/not-a-member.md",
    }),
  ).rejects.toThrow(
    "--project cannot be combined with --allow-read; the Writing Project manifest defines the Session Read Scope.",
  );
});

test("passes continuationFile through unchanged when no project is given", async () => {
  const workspaceRoot = await makeWorkspace();

  const result = await prepareWritingProjectRun({
    workspaceRoot,
    continuationFile: "draft.md",
  });

  expect(result).toEqual({
    readScopeMembers: [],
    warnings: [],
    continuationFile: "draft.md",
  });
});
