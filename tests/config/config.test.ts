import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "../harness.js";
import { loadConfig } from "../../src/config/index.js";

test("loads merged default, global, and project config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-project-"));
  await mkdir(join(homeDir, ".forgelet"), { recursive: true });
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(join(homeDir, ".forgelet", "config.json"), JSON.stringify({ defaultModel: "custom-pro" }), "utf8");
  await writeFile(join(workspaceRoot, ".forgelet", "config.json"), JSON.stringify({ safeCommands: ["npm test"] }), "utf8");

  const config = await loadConfig({ homeDir, workspaceRoot });

  assert.equal(config.defaultModel, "custom-pro");
  assert.equal(config.fallbackModel, "gpt-5");
  assert.equal(config.routing.coding.default, "deepseek-v4-pro");
  assert.equal(config.routing.writing.default, "deepseek-v4-flash");
  assert.deepEqual(config.safeCommands, ["npm test"]);
});
