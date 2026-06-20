import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAgent } from "../../src/agent/runAgent.js";
import { runCli } from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

test("CLI lists and shows project sessions", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-"));
  const run = await runAgent({
    workflow: "coding",
    task: "fix tests",
    contextFiles: [],
    workspaceRoot,
  });

  const list = await runCli(["sessions", "list"], { workspaceRoot });
  expect(list.exitCode).toBe(0);
  expect(list.stdout).toMatch(new RegExp(run.session.id));
  expect(list.stdout).toMatch(/completed/);

  const show = await runCli(["sessions", "show", run.session.id], {
    workspaceRoot,
  });
  expect(show.exitCode).toBe(0);
  expect(show.stdout).toMatch(/Workflow: coding/);
  expect(show.stdout).toMatch(/Task: fix tests/);
  expect(show.stdout).toMatch(/Execution is scaffolded/);
});

test("CLI entrypoint runs when invoked through an npm-link style symlink", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-link-"));
  const linkedBin = join(workspaceRoot, "forge");
  await symlink(join(process.cwd(), "dist", "cli", "index.js"), linkedBin);

  const result = await execNode([linkedBin, "--help"], workspaceRoot);

  expect(result.stderr).toBe("");
  expect(result.stdout).toMatch(/Forgelet/);
  expect(result.stdout).toMatch(/--live/);
});

function execNode(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(process.execPath, args, { cwd }, (error, stdout, stderr) => {
      if (error) {
        rejectExec(error);
        return;
      }
      resolveExec({ stdout, stderr });
    });
  });
}

test("CLI prints merged config", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "forgelet-cli-home-"));
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-config-"));
  await mkdir(join(homeDir, ".forgelet"), { recursive: true });
  await writeFile(
    join(homeDir, ".forgelet", "config.json"),
    JSON.stringify({ defaultModel: "custom-pro" }),
    "utf8",
  );

  const result = await runCli(["config", "get"], { homeDir, workspaceRoot });
  const config = JSON.parse(result.stdout);

  expect(result.exitCode).toBe(0);
  expect(config.defaultModel).toBe("deepseek-v4-pro");
  expect(config.routing.coding.default).toBe("deepseek-v4-pro");
});

test("CLI --live runs a read-only Session with an injected live model client", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-live-"));
  await writeFile(
    join(workspaceRoot, "example.ts"),
    "export const answer = 'needle';\n",
    "utf8",
  );
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        { id: "call_search", name: "search_text", input: { query: "needle" } },
      ],
    },
    { content: "Found needle in example.ts.", toolCalls: [] },
  ]);

  const result = await runCli(["--live", "find needle"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async (input) => {
      expect(input.workflow).toBe("coding");
      expect(input.modelOverride).toBe(undefined);
      return modelClient;
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Forgelet session completed/);
  expect(result.stdout).toMatch(/Found needle in example.ts/);
  expect(modelClient.turnInputs.length).toBe(2);
});

test("CLI --live requires a DeepSeek API key", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-live-key-"));

  const result = await runCli(["--live", "inspect repo"], {
    workspaceRoot,
    env: {},
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/DEEPSEEK_API_KEY is required for --live DeepSeek execution/);
});

test("CLI --live rejects non-DeepSeek routes", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-cli-live-route-"),
  );

  const result = await runCli(["--live", "--model", "gpt-5", "inspect repo"], {
    workspaceRoot,
    env: { DEEPSEEK_API_KEY: "test-key" },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Live execution currently supports DeepSeek models only/);
});
