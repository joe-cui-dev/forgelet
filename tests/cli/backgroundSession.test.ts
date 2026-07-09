import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { readPauseSnapshot } from "../../src/sessions/pauseSnapshot.js";

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

test("forge code --write-scope echoes the declared Effect Envelope and pauses on an out-of-envelope action", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-cli-background-"));
  await execGit(workspaceRoot, ["init"]);
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

  const result = await runCli(
    ["code", "--write-scope", "src", "write some docs"],
    {
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => modelClient,
    },
  );

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toMatch(/Effect Envelope declared:/);
  expect(result.stdout).toMatch(/Write scope: src/);
  expect(result.stdout).toMatch(/forge decide/);

  const sessionId = result.stdout.match(/session paused: (sess_\w+)/)?.[1];
  expect(sessionId).toBeDefined();
  const snapshot = await readPauseSnapshot(workspaceRoot, sessionId ?? "");
  expect(snapshot.envelope.writeScopePrefixes).toEqual(["src"]);
});
