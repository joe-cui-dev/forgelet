import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@jest/globals";
import {
  applyArtifactToProject,
  createWritingProject,
  loadWritingProject,
  saveWritingProject,
  WRITING_PROJECTS_DIR,
} from "../../src/writingProjects/index.js";

test("creates an empty Writing Project manifest", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });

  const project = await createWritingProject(workspaceRoot, "my-novel");
  const manifestPath = join(
    workspaceRoot,
    WRITING_PROJECTS_DIR,
    "my-novel.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  expect(project).toEqual(manifest);
  expect(manifest).toEqual({
    slug: "my-novel",
    createdAt: expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    ),
    head: null,
    members: [],
  });
});

test("rejects invalid Writing Project slugs", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));

  await expect(createWritingProject(workspaceRoot, "My_Novel")).rejects.toThrow(
    /Writing Project slug must use lowercase kebab-case/,
  );
});

test("rejects an existing Writing Project slug", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  await createWritingProject(workspaceRoot, "my-novel");

  await expect(createWritingProject(workspaceRoot, "my-novel")).rejects.toThrow(
    /Writing Project already exists: my-novel/,
  );
});

test("reports existing Writing Project slugs when loading an unknown project", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  await createWritingProject(workspaceRoot, "first-book");
  await createWritingProject(workspaceRoot, "second-book");

  await expect(loadWritingProject(workspaceRoot, "missing-book")).rejects.toThrow(
    /Unknown Writing Project: missing-book[\s\S]*Existing projects: first-book, second-book/,
  );
});

test("rejects manifest members outside .forgelet/writing", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  await writeManifest(workspaceRoot, "bad-project", {
    slug: "bad-project",
    createdAt: "2026-07-06T00:00:00.000Z",
    head: ".forgelet/writing/chapter.md",
    members: ["notes/chapter.md"],
  });

  await expect(loadWritingProject(workspaceRoot, "bad-project")).rejects.toThrow(
    /bad-project\.json[\s\S]*member must start with \.forgelet\/writing\//,
  );
});

test("rejects manifest members that are not Markdown artifacts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  await writeManifest(workspaceRoot, "bad-project", {
    slug: "bad-project",
    createdAt: "2026-07-06T00:00:00.000Z",
    head: ".forgelet/writing/chapter.md",
    members: [".forgelet/writing/chapter.txt"],
  });

  await expect(loadWritingProject(workspaceRoot, "bad-project")).rejects.toThrow(
    /bad-project\.json[\s\S]*member must end with \.md/,
  );
});

test("rejects a manifest head that is not a member", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  await writeManifest(workspaceRoot, "bad-project", {
    slug: "bad-project",
    createdAt: "2026-07-06T00:00:00.000Z",
    head: ".forgelet/writing/chapter-2.md",
    members: [".forgelet/writing/chapter-1.md"],
  });

  await expect(loadWritingProject(workspaceRoot, "bad-project")).rejects.toThrow(
    /bad-project\.json[\s\S]*head must be one of members/,
  );
});

test("reports the manifest path when JSON parsing fails", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  const projectsDir = join(workspaceRoot, WRITING_PROJECTS_DIR);
  await mkdir(projectsDir, { recursive: true });
  await writeFile(join(projectsDir, "bad-project.json"), "{ nope", "utf8");

  await expect(loadWritingProject(workspaceRoot, "bad-project")).rejects.toThrow(
    /Unable to parse .*bad-project\.json/,
  );
});

test("adds the first artifact to an empty Writing Project and makes it the head", () => {
  const result = applyArtifactToProject(
    {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      head: null,
      members: [],
    },
    {
      artifactPath: ".forgelet/writing/chapter-1.md",
      continuationSource: null,
    },
  );

  expect(result).toEqual({
    manifest: {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      head: ".forgelet/writing/chapter-1.md",
      members: [".forgelet/writing/chapter-1.md"],
    },
    memberAdded: ".forgelet/writing/chapter-1.md",
    headBefore: null,
    headAfter: ".forgelet/writing/chapter-1.md",
  });
});

test("advances the head when continuing from the current head", () => {
  const result = applyArtifactToProject(
    {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      head: ".forgelet/writing/chapter-1.md",
      members: [".forgelet/writing/chapter-1.md"],
    },
    {
      artifactPath: ".forgelet/writing/chapter-2.md",
      continuationSource: ".forgelet/writing/chapter-1.md",
    },
  );

  expect(result.manifest.members).toEqual([
    ".forgelet/writing/chapter-1.md",
    ".forgelet/writing/chapter-2.md",
  ]);
  expect(result.headBefore).toBe(".forgelet/writing/chapter-1.md");
  expect(result.headAfter).toBe(".forgelet/writing/chapter-2.md");
  expect(result.manifest.head).toBe(".forgelet/writing/chapter-2.md");
});

test("keeps the head when continuing from an older member", () => {
  const result = applyArtifactToProject(
    {
      slug: "my-novel",
      createdAt: "2026-07-06T00:00:00.000Z",
      head: ".forgelet/writing/chapter-3.md",
      members: [
        ".forgelet/writing/chapter-1.md",
        ".forgelet/writing/chapter-2.md",
        ".forgelet/writing/chapter-3.md",
      ],
    },
    {
      artifactPath: ".forgelet/writing/chapter-1-revision.md",
      continuationSource: ".forgelet/writing/chapter-1.md",
    },
  );

  expect(result.manifest.members).toEqual([
    ".forgelet/writing/chapter-1.md",
    ".forgelet/writing/chapter-2.md",
    ".forgelet/writing/chapter-3.md",
    ".forgelet/writing/chapter-1-revision.md",
  ]);
  expect(result.headBefore).toBe(".forgelet/writing/chapter-3.md");
  expect(result.headAfter).toBe(".forgelet/writing/chapter-3.md");
  expect(result.manifest.head).toBe(".forgelet/writing/chapter-3.md");
});

test("saves and reloads an updated Writing Project manifest", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-project-"));
  const project = await createWritingProject(workspaceRoot, "my-novel");
  const result = applyArtifactToProject(project, {
    artifactPath: ".forgelet/writing/chapter-1.md",
    continuationSource: null,
  });

  await saveWritingProject(workspaceRoot, result.manifest);

  await expect(loadWritingProject(workspaceRoot, "my-novel")).resolves.toEqual(
    result.manifest,
  );
});

async function writeManifest(
  workspaceRoot: string,
  slug: string,
  manifest: unknown,
): Promise<void> {
  const projectsDir = join(workspaceRoot, WRITING_PROJECTS_DIR);
  await mkdir(projectsDir, { recursive: true });
  await writeFile(
    join(projectsDir, `${slug}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
