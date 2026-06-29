import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  runCreativeWritingSmoke,
  validateCreativeWritingSmokeEvidence,
} from "../../src/smoke/writingCreative.js";

test("creative writing smoke evidence accepts a completed Revision Pack Session", () => {
  const result = validateCreativeWritingSmokeEvidence({
    stdout: [
      "Workflow: writing",
      "Workflow variant: creative",
      "Creative style: vivid",
      "Trace: /repo/.forgelet/sessions/sess_creative.jsonl",
      "",
      "Critique",
      "The scene is clear but thin.",
      "",
      "Revision",
      "The room breathed winter through the walls.",
      "",
      "Alternatives",
      "1. Frost moved quietly under the door.",
      "2. The room was cold and still.",
      "",
      "Notes",
      "Kept the moment short.",
    ].join("\n"),
    tracePath: "/repo/.forgelet/sessions/sess_creative.jsonl",
    traceEvents: [
      {
        type: "session_started",
        sessionId: "sess_creative",
        payload: {
          workflow: "writing",
          workflowVariant: "creative",
          creativeStyle: "vivid",
        },
      },
      {
        type: "context_attachment",
        sessionId: "sess_creative",
        payload: {
          title: "scene.md",
          uri: "fixtures/writing/scene.md",
        },
      },
      {
        type: "routing_selected",
        sessionId: "sess_creative",
        payload: {
          model: "deepseek-v4-flash",
          reason: "default route for writing workflow",
        },
      },
      {
        type: "final_summary",
        sessionId: "sess_creative",
        payload: {
          summary:
            "Critique\n...\nRevision\n...\nAlternatives\n1. ...\n2. ...\nNotes\n...",
        },
      },
      {
        type: "session_finished",
        sessionId: "sess_creative",
        payload: {
          status: "completed",
        },
      },
    ],
  });

  expect(result.sessionId).toBe("sess_creative");
  expect(result.tracePath).toMatch(/sess_creative\.jsonl$/);
  expect(result.model).toBe("deepseek-v4-flash");
});

test("creative writing smoke runs the CLI in the project workspace and reads the new Trace", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "forgelet-smoke-test-"));
  await mkdir(join(testRoot, "fixtures", "writing"), { recursive: true });
  const contextPath = "fixtures/writing/scene.md";
  const fixturePath = join(testRoot, contextPath);
  const cliPath = join(testRoot, "fake-forge-cli.mjs");
  await writeFile(fixturePath, "城市的清晨从一碗粥开始。\n", "utf8");
  await writeFile(
    cliPath,
    [
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (!process.argv.includes('--creative')) process.exit(20);",
      "if (!process.argv.includes('--style')) process.exit(21);",
      "if (!existsSync(join(process.cwd(), 'fixtures', 'writing', 'scene.md'))) process.exit(22);",
      "mkdirSync(join(process.cwd(), '.forgelet', 'sessions'), { recursive: true });",
      "const tracePath = join(process.cwd(), '.forgelet', 'sessions', 'sess_creative.jsonl');",
      "const event = (type, payload) => JSON.stringify({ type, sessionId: 'sess_creative', payload });",
      "writeFileSync(tracePath, [",
      "  event('session_started', { workflow: 'writing', workflowVariant: 'creative', creativeStyle: 'vivid' }),",
      "  event('context_attachment', { title: 'scene.md', uri: 'fixtures/writing/scene.md' }),",
      "  event('routing_selected', { model: 'deepseek-v4-flash', reason: 'default route for writing workflow' }),",
      "  event('final_summary', { summary: 'Critique\\nRevision\\nAlternatives\\n1. A\\n2. B\\nNotes' }),",
      "  event('session_finished', { status: 'completed' })",
      "].join('\\n') + '\\n');",
      "console.log('Critique\\nOk\\n\\nRevision\\nOk\\n\\nAlternatives\\n1. A\\n2. B\\n\\nNotes\\nOk');",
    ].join("\n"),
    "utf8",
  );

  const result = await runCreativeWritingSmoke({
    cliPath,
    workspaceRoot: testRoot,
    contextPath,
  });

  expect(result.sessionId).toBe("sess_creative");
  expect(result.workspaceRoot).toBe(testRoot);
  expect(result.tracePath).toMatch(/sess_creative\.jsonl$/);
  expect(result.stdout).toMatch(/Alternatives/);
});

test("creative writing smoke accepts labeled Alternatives from a real Revision Pack", () => {
  const result = validateCreativeWritingSmokeEvidence({
    stdout: [
      "Critique",
      "Ok",
      "",
      "Revision",
      "Ok",
      "",
      "Alternatives",
      "",
      "#### Alternative A: More Vivid / Literary",
      "A vivid option.",
      "",
      "#### Alternative B: Clearer / Tighter",
      "A tighter option.",
      "",
      "Notes",
      "Ok",
    ].join("\n"),
    tracePath: "/tmp/sess_creative.jsonl",
    traceEvents: [
      {
        type: "session_started",
        sessionId: "sess_creative",
        payload: {
          workflow: "writing",
          workflowVariant: "creative",
          creativeStyle: "vivid",
        },
      },
      {
        type: "context_attachment",
        sessionId: "sess_creative",
        payload: {
          title: "scene.md",
          uri: "fixtures/writing/scene.md",
        },
      },
      {
        type: "routing_selected",
        sessionId: "sess_creative",
        payload: { model: "deepseek-v4-flash" },
      },
      {
        type: "final_summary",
        sessionId: "sess_creative",
        payload: { summary: "ok" },
      },
      {
        type: "session_finished",
        sessionId: "sess_creative",
        payload: { status: "completed" },
      },
    ],
  });

  expect(result.sessionId).toBe("sess_creative");
});
