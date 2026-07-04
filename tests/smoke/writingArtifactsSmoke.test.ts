import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runWritingArtifactsSmoke,
  validateWritingArtifactsSmokeEvidence,
} from "../../src/smoke/writingArtifacts.js";

test("Writing Artifact Catalog smoke evidence accepts catalog list and show output", () => {
  const result = validateWritingArtifactsSmokeEvidence({
    writeStdout: [
      "Draft",
      "Rain brightened the store windows.",
      "Writing artifact: .forgelet/writing/rain-sess_artifacts.md (draft, 36 bytes)",
      "Trace: /repo/.forgelet/sessions/sess_artifacts.jsonl",
    ].join("\n"),
    listStdout: [
      "Writing Artifact Catalog",
      "Path: .forgelet/writing",
      "Artifacts: 1",
      "",
      "1. rain-sess_artifacts.md",
      "   Status: available",
      "   Kind: draft",
      "   Session: sess_artifacts",
      "   Continue: forge write --creative --style vivid --continue .forgelet/writing/rain-sess_artifacts.md \"<brief>\"",
    ].join("\n"),
    showStdout: [
      "Writing Artifact",
      "Path: .forgelet/writing/rain-sess_artifacts.md",
      "Status: available",
      "Session: sess_artifacts",
      "Continue: forge write --creative --style vivid --continue .forgelet/writing/rain-sess_artifacts.md \"<brief>\"",
      "",
      "Preview:",
      "Rain brightened the store windows.",
    ].join("\n"),
    tracePath: "/repo/.forgelet/sessions/sess_artifacts.jsonl",
    traceEvents: [
      {
        type: "session_started",
        sessionId: "sess_artifacts",
        payload: {
          workflow: "writing",
          workflowVariant: "creative",
          creativeStyle: "vivid",
        },
      },
      {
        type: "writing_artifact",
        sessionId: "sess_artifacts",
        payload: {
          path: ".forgelet/writing/rain-sess_artifacts.md",
          contentKind: "draft",
          contentBytes: 36,
        },
      },
      {
        type: "final_summary",
        sessionId: "sess_artifacts",
        payload: {
          summary: "Draft\nRain brightened the store windows.",
          writingArtifact: {
            path: ".forgelet/writing/rain-sess_artifacts.md",
            contentKind: "draft",
            contentBytes: 36,
          },
        },
      },
      {
        type: "session_finished",
        sessionId: "sess_artifacts",
        payload: { status: "completed" },
      },
    ],
    traceFilesAfterWrite: ["sess_artifacts.jsonl"],
    traceFilesAfterCatalogReads: ["sess_artifacts.jsonl"],
  });

  expect(result.sessionId).toBe("sess_artifacts");
  expect(result.artifactPath).toBe(".forgelet/writing/rain-sess_artifacts.md");
  expect(result.tracePath).toMatch(/sess_artifacts\.jsonl$/);
});

test("Writing Artifact Catalog smoke runs write, list, and show through the CLI", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "forgelet-artifact-smoke-test-"));
  const cliPath = join(testRoot, "fake-forge-cli.mjs");
  await writeFile(
    cliPath,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const args = process.argv.slice(2);",
      "const sessionDir = join(process.cwd(), '.forgelet', 'sessions');",
      "const writingDir = join(process.cwd(), '.forgelet', 'writing');",
      "mkdirSync(sessionDir, { recursive: true });",
      "mkdirSync(writingDir, { recursive: true });",
      "if (args[0] === 'write' && args[1] === 'artifacts' && args[2] === 'list') {",
      "  console.log('Writing Artifact Catalog\\nPath: .forgelet/writing\\nArtifacts: 1\\n\\n1. rain-sess_artifacts.md\\n   Status: available\\n   Kind: draft\\n   Session: sess_artifacts\\n   Continue: forge write --creative --style vivid --continue .forgelet/writing/rain-sess_artifacts.md \"<brief>\"');",
      "  process.exit(0);",
      "}",
      "if (args[0] === 'write' && args[1] === 'artifacts' && args[2] === 'show' && args[3] === 'sess_artifacts') {",
      "  console.log('Writing Artifact\\nPath: .forgelet/writing/rain-sess_artifacts.md\\nStatus: available\\nSession: sess_artifacts\\nContinue: forge write --creative --style vivid --continue .forgelet/writing/rain-sess_artifacts.md \"<brief>\"\\n\\nPreview:\\nRain brightened the store windows.');",
      "  process.exit(0);",
      "}",
      "if (!args.includes('--creative')) process.exit(20);",
      "writeFileSync(join(writingDir, 'rain-sess_artifacts.md'), 'Rain brightened the store windows.\\n');",
      "const event = (type, payload) => JSON.stringify({ type, sessionId: 'sess_artifacts', payload });",
      "writeFileSync(join(sessionDir, 'sess_artifacts.jsonl'), [",
      "  event('session_started', { workflow: 'writing', workflowVariant: 'creative', creativeStyle: 'vivid' }),",
      "  event('writing_artifact', { path: '.forgelet/writing/rain-sess_artifacts.md', contentKind: 'draft', contentBytes: 36 }),",
      "  event('final_summary', { summary: 'Draft\\nRain brightened the store windows.', writingArtifact: { path: '.forgelet/writing/rain-sess_artifacts.md', contentKind: 'draft', contentBytes: 36 } }),",
      "  event('session_finished', { status: 'completed' })",
      "].join('\\n') + '\\n');",
      "console.log('Draft\\nRain brightened the store windows.\\nWriting artifact: .forgelet/writing/rain-sess_artifacts.md (draft, 36 bytes)\\nTrace: ' + join(process.cwd(), '.forgelet', 'sessions', 'sess_artifacts.jsonl'));",
    ].join("\n"),
    "utf8",
  );

  const result = await runWritingArtifactsSmoke({
    cliPath,
    workspaceRoot: testRoot,
  });

  expect(result.sessionId).toBe("sess_artifacts");
  expect(result.workspaceRoot).toBe(testRoot);
  expect(result.listStdout).toMatch(/Writing Artifact Catalog/);
  expect(result.showStdout).toMatch(/Preview:/);
});
