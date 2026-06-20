import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config/index.js";

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

  expect(config.defaultModel).toBe("deepseek-v4-pro");
  expect(config.fallbackModel).toBe("gpt-5");
  expect(config.routing.coding.default).toBe("deepseek-v4-pro");
  expect(config.routing.writing.default).toBe("deepseek-v4-flash");
  expect(config.safeCommands).toEqual(["npm test"]);
  expect(config.commandTimeoutMs).toBe(12_345);
  expect(config.maxPatchBytes).toBe(54_321);
});
