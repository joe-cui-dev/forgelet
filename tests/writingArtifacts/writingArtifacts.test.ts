import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@jest/globals";
import {
  readWritingArtifactCatalog,
  searchWritingArtifacts,
} from "../../src/writingArtifacts/index.js";

test("reads a Writing Artifact Catalog from traces and local artifacts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-artifacts-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "available-sess_available.md"),
    "Draft body\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "untracked.md"),
    "Loose body\n",
    "utf8",
  );
  await utimes(
    join(workspaceRoot, ".forgelet", "writing", "untracked.md"),
    new Date("2026-07-04T08:00:00.000Z"),
    new Date("2026-07-04T08:00:00.000Z"),
  );
  await writeTrace(workspaceRoot, "sess_available", [
    event("session_started", "sess_available", {
      workflow: "writing",
      workflowVariant: "creative",
      creativeStyle: "vivid",
      startedAt: "2026-07-04T10:00:00.000Z",
    }),
    event("user_task", "sess_available", {
      task: "write a rain-soaked convenience store scene",
    }),
    event("writing_artifact", "sess_available", {
      path: ".forgelet/writing/available-sess_available.md",
      contentKind: "draft",
      contentBytes: 11,
    }, "2026-07-04T10:22:00.000Z"),
  ]);
  await writeTrace(workspaceRoot, "sess_missing", [
    event("session_started", "sess_missing", {
      workflow: "writing",
      workflowVariant: "creative",
      startedAt: "2026-07-04T09:00:00.000Z",
    }),
    event("user_task", "sess_missing", { task: "missing prose" }),
    event("writing_artifact", "sess_missing", {
      path: ".forgelet/writing/missing-sess_missing.md",
      contentKind: "revision",
      contentBytes: 42,
    }, "2026-07-04T09:30:00.000Z"),
  ]);
  await rm(join(workspaceRoot, ".forgelet", "writing", "missing-sess_missing.md"), {
    force: true,
  });

  const catalog = await readWritingArtifactCatalog(workspaceRoot);

  expect(catalog.path).toBe(".forgelet/writing");
  expect(catalog.entries.map((entry) => entry.path)).toEqual([
    ".forgelet/writing/available-sess_available.md",
    ".forgelet/writing/missing-sess_missing.md",
    ".forgelet/writing/untracked.md",
  ]);
  expect(catalog.entries[0]).toEqual(
    expect.objectContaining({
      status: "available",
      contentKind: "draft",
      contentBytes: 11,
      sessionId: "sess_available",
      createdAt: "2026-07-04T10:22:00.000Z",
      task: "write a rain-soaked convenience store scene",
      workflowVariant: "creative",
      creativeStyle: "vivid",
      tracePath: ".forgelet/sessions/sess_available.jsonl",
    }),
  );
  expect(catalog.entries[1]).toEqual(
    expect.objectContaining({
      status: "missing",
      contentKind: "revision",
      contentBytes: 42,
      sessionId: "sess_missing",
    }),
  );
  expect(catalog.entries[2]).toMatchObject({
    status: "untracked",
    contentKind: "unknown",
  });
  expect(catalog.entries[2]).not.toHaveProperty("sessionId");
  expect(catalog.entries[2]).not.toHaveProperty("tracePath");
});

test("searches available Writing Artifact bodies with case-insensitive snippets", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-search-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "rain-sess_rain.md"),
    "The neon RAIN scene keeps humming after midnight.\n",
    "utf8",
  );
  await writeTrace(workspaceRoot, "sess_rain", [
    event("session_started", "sess_rain", {
      workflow: "writing",
      workflowVariant: "creative",
      creativeStyle: "vivid",
    }),
    event("user_task", "sess_rain", {
      task: "write a convenience store scene",
    }),
    event("writing_artifact", "sess_rain", {
      path: ".forgelet/writing/rain-sess_rain.md",
      contentKind: "draft",
      contentBytes: 50,
    }, "2026-07-04T10:22:00.000Z"),
  ]);

  const result = await searchWritingArtifacts(workspaceRoot, {
    query: "rain scene",
    limit: 10,
  });

  expect(result.path).toBe(".forgelet/writing");
  expect(result.query).toBe("rain scene");
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toEqual(
    expect.objectContaining({
      path: ".forgelet/writing/rain-sess_rain.md",
      status: "available",
    }),
  );
  expect(result.entries[0]?.snippet).toContain("RAIN scene");
});

test("searches Catalog metadata and applies newest-first limits across statuses", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-writing-search-"));
  await mkdir(join(workspaceRoot, ".forgelet", "writing"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "body-sess_body.md"),
    "A midnight market scene with rain on the glass.\n",
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "writing", "untracked-market.md"),
    "Loose market vignette.\n",
    "utf8",
  );
  await utimes(
    join(workspaceRoot, ".forgelet", "writing", "untracked-market.md"),
    new Date("2026-07-04T10:30:00.000Z"),
    new Date("2026-07-04T10:30:00.000Z"),
  );
  await writeTrace(workspaceRoot, "sess_body", [
    event("session_started", "sess_body", {
      workflow: "writing",
      workflowVariant: "creative",
      creativeStyle: "vivid",
    }),
    event("user_task", "sess_body", { task: "write a city scene" }),
    event("writing_artifact", "sess_body", {
      path: ".forgelet/writing/body-sess_body.md",
      contentKind: "draft",
      contentBytes: 48,
    }, "2026-07-04T10:00:00.000Z"),
  ]);
  await writeTrace(workspaceRoot, "sess_missing", [
    event("session_started", "sess_missing", {
      workflow: "writing",
      workflowVariant: "creative",
      creativeStyle: "plain",
    }),
    event("user_task", "sess_missing", { task: "missing market scene" }),
    event("writing_artifact", "sess_missing", {
      path: ".forgelet/writing/missing-sess_missing.md",
      contentKind: "revision",
      contentBytes: 42,
    }, "2026-07-04T11:00:00.000Z"),
  ]);

  const result = await searchWritingArtifacts(workspaceRoot, {
    query: "market",
    limit: 2,
  });

  expect(result.entries.map((entry) => entry.path)).toEqual([
    ".forgelet/writing/missing-sess_missing.md",
    ".forgelet/writing/untracked-market.md",
  ]);
  expect(result.entries[0]).toEqual(
    expect.objectContaining({
      status: "missing",
      snippet: "unavailable; artifact file is missing",
    }),
  );
  expect(result.entries[1]).toEqual(
    expect.objectContaining({
      status: "untracked",
    }),
  );

  const noResults = await searchWritingArtifacts(workspaceRoot, {
    query: "does-not-exist",
    limit: 10,
  });
  expect(noResults.entries).toEqual([]);
});

async function writeTrace(
  workspaceRoot: string,
  sessionId: string,
  events: unknown[],
): Promise<void> {
  const sessionDir = join(workspaceRoot, ".forgelet", "sessions");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${sessionId}.jsonl`),
    events.map((entry) => JSON.stringify(entry)).join("\n"),
    "utf8",
  );
}

function event(
  type: string,
  sessionId: string,
  payload: Record<string, unknown>,
  ts = "2026-07-04T00:00:00.000Z",
): Record<string, unknown> {
  return { type, ts, sessionId, payload };
}
