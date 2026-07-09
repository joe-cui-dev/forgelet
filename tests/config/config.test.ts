import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, setGlobalConfigValue } from "../../src/config/index.js";

test("default actionable Sessions can run the repository typecheck", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-default-config-"),
  );

  const config = await loadConfig({ workspaceRoot });

  expect(config.safeCommands).toContain("npm run typecheck");
});

test("defaults the active observation working-set target", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-active-context-"),
  );

  const config = await loadConfig({ workspaceRoot });

  expect(config.activeContext.maxConversationBytes).toBe(131_072);
  expect(config.activeContext.observationDigestPreviewBytes).toBe(2_048);
  expect(config.activeContext.protectedRecentTurns).toBe(3);
});

test("rejects an invalid protected recent turns count", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-protected-turns-invalid-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ activeContext: { protectedRecentTurns: 0 } }),
    "utf8",
  );

  await expect(loadConfig({ workspaceRoot })).rejects.toThrow(
    /activeContext\.protectedRecentTurns.*at least 1/,
  );
});

test("hard-errors when setting the renamed observation byte key", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-rename-error-"));

  await expect(
    setGlobalConfigValue({
      homeDir,
      key: "activeContext.maxObservationBytes",
      value: "20000",
    }),
  ).rejects.toThrow(/activeContext\.maxConversationBytes/);
});

test("loads merged default, global, and project config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-"));
  await mkdir(join(homeDir, ".forgelet"), { recursive: true });
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "config.json"),
    JSON.stringify({
      defaultModel: "custom-pro",
      activeContext: { maxConversationBytes: 60_000 },
    }),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      routing: { coding: { default: "local-coding-model" } },
      safeCommands: ["npm test"],
      commandTimeoutMs: 12_345,
      maxPatchBytes: 54_321,
      activeContext: {
        maxConversationBytes: 70_000,
        observationDigestPreviewBytes: 3_000,
      },
    }),
    "utf8",
  );

  const config = await loadConfig({ homeDir, workspaceRoot });

  expect(config.defaultModel).toBe("deepseek-v4-flash");
  expect(config.fallbackModel).toBe("gpt-5");
  expect(config.routing.coding.default).toBe("deepseek-v4-flash");
  expect(config.routing.writing.default).toBe("deepseek-v4-flash");
  expect(config.routing.learning.default).toBe("deepseek-v4-flash");
  expect(config.routing.learning.review).toBe("deepseek-v4-flash");
  expect(config.safeCommands).toEqual(["npm test"]);
  expect(config.commandTimeoutMs).toBe(12_345);
  expect(config.maxPatchBytes).toBe(54_321);
  expect(config.activeContext.maxConversationBytes).toBe(70_000);
  expect(config.activeContext.observationDigestPreviewBytes).toBe(3_000);
});

test("rejects an invalid active observation working-set target", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-active-invalid-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({ activeContext: { maxConversationBytes: 4_095 } }),
    "utf8",
  );

  await expect(loadConfig({ workspaceRoot })).rejects.toThrow(
    /activeContext\.maxConversationBytes.*4096/,
  );
});

test("rejects an invalid observation digest preview cap", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-digest-invalid-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      activeContext: { observationDigestPreviewBytes: 127 },
    }),
    "utf8",
  );

  await expect(loadConfig({ workspaceRoot })).rejects.toThrow(
    /activeContext\.observationDigestPreviewBytes.*128/,
  );
});
