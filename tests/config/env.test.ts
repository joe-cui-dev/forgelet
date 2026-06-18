import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "../harness.js";
import { loadDotEnv } from "../../src/config/env.js";

test("loads local .env values without overriding existing environment", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-env-"));
  await writeFile(
    join(workspaceRoot, ".env"),
    [
      "# local secrets",
      "DEEPSEEK_API_KEY=from-file",
      "DEEPSEEK_MODEL=deepseek-v4-flash # local default",
      'export QUOTED="hello\\nworld"',
      "SINGLE='literal value'",
    ].join("\n"),
    "utf8",
  );
  const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "from-shell" };

  await loadDotEnv({ workspaceRoot, env });

  assert.equal(env.DEEPSEEK_API_KEY, "from-shell");
  assert.equal(env.DEEPSEEK_MODEL, "deepseek-v4-flash");
  assert.equal(env.QUOTED, "hello\nworld");
  assert.equal(env.SINGLE, "literal value");
});

test("missing .env files are ignored", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-env-missing-"));
  const env: NodeJS.ProcessEnv = {};

  await loadDotEnv({ workspaceRoot, env });

  assert.deepEqual(env, {});
});
