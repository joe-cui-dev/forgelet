import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig } from "../../src/config/index.js";

test("default actionable Sessions can run the repository typecheck", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-default-config-"));

  const config = await loadConfig({ workspaceRoot });

  expect(config.safeCommands).toContain("npm run typecheck");
});

test("loads merged default, global, and project config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-"));
  await mkdir(join(homeDir, ".forgelet"), { recursive: true });
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "config.json"),
    JSON.stringify({ defaultModel: "custom-pro" }),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, ".forgelet", "config.json"),
    JSON.stringify({
      routing: { coding: { default: "local-coding-model" } },
      safeCommands: ["npm test"],
      commandTimeoutMs: 12_345,
      maxPatchBytes: 54_321,
    }),
    "utf8",
  );

  const config = await loadConfig({ homeDir, workspaceRoot });

  expect(config.defaultModel).toBe("deepseek-v4-flash");
  expect(config.fallbackModel).toBe("gpt-5");
  expect(config.routing.coding.default).toBe("deepseek-v4-flash");
  expect(config.routing.writing.default).toBe("deepseek-v4-flash");
  expect(config.safeCommands).toEqual(["npm test"]);
  expect(config.commandTimeoutMs).toBe(12_345);
  expect(config.maxPatchBytes).toBe(54_321);
});
