import { expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli } from "../../src/cli/index.js";
import { FakeModelClient } from "../../src/models/testing/index.js";
import { readTraceFile } from "../../src/trace/index.js";

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

test("background session smoke: declare envelope, auto-approve, pause, queue, decide(widen), resume, complete", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-smoke-background-"));
  await execGit(workspaceRoot, ["init"]);

  const startModelClient = new FakeModelClient([
    {
      toolCalls: [
        {
          id: "call_in_envelope",
          name: "apply_patch",
          input: { patch: newFilePatch("src/app.ts", "console.log(1);") },
        },
      ],
    },
    {
      toolCalls: [
        {
          id: "call_out_of_envelope",
          name: "apply_patch",
          input: { patch: newFilePatch("docs/notes.md", "notes") },
        },
      ],
    },
  ]);

  const startResult = await runCli(
    ["code", "--write-scope", "src", "write app and notes"],
    {
      workspaceRoot,
      env: {},
      createLiveModelClient: async () => startModelClient,
    },
  );
  expect(startResult.exitCode).toBe(0);
  expect(startResult.stdout).toMatch(/Effect Envelope declared:/);
  const sessionId = startResult.stdout.match(/session paused: (sess_\w+)/)?.[1];
  if (!sessionId) throw new Error(`no paused session id in: ${startResult.stdout}`);

  const queueResult = await runCli(["queue"], { workspaceRoot, env: {} });
  expect(queueResult.exitCode).toBe(0);
  expect(queueResult.stdout).toMatch(sessionId);
  expect(queueResult.stdout).toMatch(/apply_patch/);
  expect(queueResult.stdout).toMatch(/docs\/notes\.md/);

  const resumeModelClient = new FakeModelClient([
    { content: "Wrote both files.", toolCalls: [] },
  ]);
  const decideResult = await runCli(["decide"], {
    workspaceRoot,
    env: {},
    createLiveModelClient: async () => resumeModelClient,
    decidePrompt: async () => "w",
  });

  expect(decideResult.exitCode).toBe(0);
  expect(decideResult.stdout).toMatch(/Forgelet session completed/);
  await expect(readFile(join(workspaceRoot, "src/app.ts"), "utf8")).resolves.toBe(
    "console.log(1);\n",
  );
  await expect(readFile(join(workspaceRoot, "docs/notes.md"), "utf8")).resolves.toBe(
    "notes\n",
  );

  const tracePath = decideResult.stdout.match(/Trace: (.+)$/m)?.[1];
  if (!tracePath) throw new Error(`no trace path in: ${decideResult.stdout}`);
  const events = await readTraceFile(tracePath);
  expect(events.every((event) => event.sessionId === sessionId)).toBe(true);

  const eventTypeOrder = events.map((event) => event.type);
  const indexOf = (type: string): number => eventTypeOrder.indexOf(type);
  const lastIndexOf = (type: string): number => eventTypeOrder.lastIndexOf(type);

  // The whole story lives in one continuous, chronologically ordered Trace
  // file (ADR 0027: pause is the same Session, same Trace).
  expect(indexOf("session_started")).toBe(0);
  expect(indexOf("session_started")).toBeLessThan(indexOf("approval_decision"));
  expect(indexOf("approval_decision")).toBeLessThan(indexOf("session_paused"));
  expect(indexOf("session_paused")).toBeLessThan(indexOf("session_resumed"));
  expect(indexOf("session_resumed")).toBeLessThan(indexOf("envelope_amended"));
  expect(indexOf("envelope_amended")).toBeLessThan(lastIndexOf("approval_decision"));
  expect(lastIndexOf("approval_decision")).toBeLessThan(indexOf("session_finished"));
  expect(eventTypeOrder.filter((type) => type === "session_finished")).toHaveLength(1);
  expect(eventTypeOrder.filter((type) => type === "session_paused")).toHaveLength(1);

  const inEnvelopeApproval = events.find(
    (event) =>
      event.type === "approval_decision" && event.payload.toolCallId === "call_in_envelope",
  );
  expect(inEnvelopeApproval?.payload.reason).toMatch(/Effect Envelope/);

  const finalEvent = events.at(-1);
  expect(finalEvent?.type).toBe("session_finished");
  expect(finalEvent?.payload.status).toBe("completed");
});
