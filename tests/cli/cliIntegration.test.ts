import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "../harness.js";
import { runAgent } from "../../src/agent/runAgent.js";
import { runCli } from "../../src/cli/index.js";

test("CLI lists and shows project sessions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-"));
  const run = await runAgent({
    workflow: "coding",
    task: "fix tests",
    contextFiles: [],
    workspaceRoot
  });

  const list = await runCli(["sessions", "list"], { workspaceRoot });
  assert.equal(list.exitCode, 0);
  assert.match(list.stdout, new RegExp(run.session.id));
  assert.match(list.stdout, /completed/);

  const show = await runCli(["sessions", "show", run.session.id], { workspaceRoot });
  assert.equal(show.exitCode, 0);
  assert.match(show.stdout, /Workflow: coding/);
  assert.match(show.stdout, /Task: fix tests/);
  assert.match(show.stdout, /Execution is scaffolded/);
});

test("CLI prints merged config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-config-"));
  await mkdir(join(homeDir, ".forgelet"), { recursive: true });
  await writeFile(join(homeDir, ".forgelet", "config.json"), JSON.stringify({ defaultModel: "custom-pro" }), "utf8");

  const result = await runCli(["config", "get"], { homeDir, workspaceRoot });
  const config = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 0);
  assert.equal(config.defaultModel, "custom-pro");
  assert.equal(config.routing.coding.default, "deepseek-v4-pro");
});
