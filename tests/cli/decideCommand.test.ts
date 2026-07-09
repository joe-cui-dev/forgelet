import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";

function execGit(workspaceRoot: string, args: string[]): Promise<void> {
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
      { cwd: workspaceRoot },
      (error) => {
        if (error) rejectExec(error);
        else resolveExec();
      },
    );
  });
}

const newFilePatch = (path: string, content: string): string =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..7e4a5c3",
    "--- /dev/null",
    `+++ b/${path}`,
    "@@ -0,0 +1,1 @@",
    `+${content}`,
  ].join("\n");

async function pauseSession(workspaceRoot: string): Promise<string> {
  const modelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_notes",
          name: "apply_patch",
          input: { patch: newFilePatch("docs/notes.md", "notes") },
        },
      ],
    },
  ]);
  const result = await runCli(["code", "--write-scope", "src", "write docs"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () => modelClient,
  });
  const sessionId = result.stdout.match(/session paused: (sess_\w+)/)?.[1];
  if (!sessionId) throw new Error(`could not find paused session id in: ${result.stdout}`);
  return sessionId;
}

test("forge queue reports a paused session's pending action", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-queue-"));
  await execGit(workspaceRoot, ["init"]);
  const sessionId = await pauseSession(workspaceRoot);

  const result = await runCli(["queue"], { workspaceRoot, env: {} });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(sessionId);
  expect(result.stdout).toMatch(/apply_patch/);
  expect(result.stdout).toMatch(new RegExp(`forge decide ${sessionId}`));
});

test("forge queue reports nothing paused when the queue is empty", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-queue-empty-"));

  const result = await runCli(["queue"], { workspaceRoot, env: {} });

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("No Sessions are paused.");
});

test("forge decide approves the pending action for the sole paused session with no id given", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-decide-"));
  await execGit(workspaceRoot, ["init"]);
  const sessionId = await pauseSession(workspaceRoot);
  const resumeModelClient = new FakeModelClient([
    { content: "Applied the notes.", toolCalls: [] },
  ]);
  let promptSeen = "";

  const result = await runCli(["decide"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () => resumeModelClient,
    decidePrompt: async (prompt) => {
      promptSeen = prompt;
      return "a";
    },
  });

  expect(result.exitCode).toBe(0);
  expect(promptSeen).toMatch(/apply a patch/);
  expect(result.stdout).toMatch(/Forgelet session completed/);
  await expect(
    readFile(join(workspaceRoot, "docs/notes.md"), "utf8"),
  ).resolves.toBe("notes\n");
  void sessionId;
});

test("forge decide rejects an unrecognized decision answer", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-decide-bad-"));
  await execGit(workspaceRoot, ["init"]);
  await pauseSession(workspaceRoot);

  const result = await runCli(["decide"], {
    workspaceRoot,
    env: {},
    decidePrompt: async () => "maybe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Unrecognized decision/);
});

test("forge decide requires a session id when multiple sessions are paused", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-decide-multi-"));
  await execGit(workspaceRoot, ["init"]);
  await pauseSession(workspaceRoot);
  await pauseSession(workspaceRoot);

  const result = await runCli(["decide"], { workspaceRoot, env: {} });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/Multiple Sessions are paused/);
});
