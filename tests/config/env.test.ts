import { expect, test } from "@jest/globals";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

  expect(env.DEEPSEEK_API_KEY).toBe("from-shell");
  expect(env.DEEPSEEK_MODEL).toBe("deepseek-v4-flash");
  expect(env.QUOTED).toBe("hello\nworld");
  expect(env.SINGLE).toBe("literal value");
});

test("missing .env files are ignored", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-env-missing-"));
  const env: NodeJS.ProcessEnv = {};

  await loadDotEnv({ workspaceRoot, env });

  expect(env).toEqual({});
});
