import { expect, test } from "@jest/globals";
import { existsSync } from "fs";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runLearningSmoke } from "../../src/smoke/learning.js";

test("learning smoke runs the CLI in the project workspace and validates Learning Pack trace evidence", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "forgelet-learning-smoke-test-"));
  await mkdir(join(testRoot, "fixtures", "learning"), { recursive: true });
  const contextPath = "fixtures/learning/article.md";
  const fixturePath = join(testRoot, contextPath);
  const cliPath = join(testRoot, "fake-forge-cli.mjs");
  await writeFile(
    fixturePath,
    "Retrieval practice strengthens memory by forcing recall before review.\n",
    "utf8",
  );
  await writeFile(
    cliPath,
    [
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.argv[2] !== 'learn') process.exit(20);",
      "if (!process.argv.includes('--context')) process.exit(21);",
      "if (!existsSync(join(process.cwd(), 'fixtures', 'learning', 'article.md'))) process.exit(22);",
      "mkdirSync(join(process.cwd(), '.forgelet', 'sessions'), { recursive: true });",
      "const tracePath = join(process.cwd(), '.forgelet', 'sessions', 'sess_learning.jsonl');",
      "const event = (type, payload) => JSON.stringify({ type, sessionId: 'sess_learning', payload });",
      "writeFileSync(tracePath, [",
      "  event('session_started', { workflow: 'learning' }),",
      "  event('context_attachment', { title: 'article.md', uri: 'fixtures/learning/article.md' }),",
      "  event('routing_selected', { model: 'deepseek-v4-flash', reason: 'default route for learning workflow' }),",
      "  event('final_summary', { summary: 'Summary\\nOk\\n\\nKey Concepts\\nOk\\n\\nSource Links\\n- article.md\\n\\nOpen Questions\\nOk\\n\\nReview Prompts\\nOk' }),",
      "  event('session_finished', { status: 'completed' })",
      "].join('\\n') + '\\n');",
      "console.log('Summary\\nOk\\n\\nKey Concepts\\nOk\\n\\nSource Links\\n- article.md\\n\\nOpen Questions\\nOk\\n\\nReview Prompts\\nOk');",
    ].join("\n"),
    "utf8",
  );

  const result = await runLearningSmoke({
    cliPath,
    workspaceRoot: testRoot,
    contextPath,
  });

  expect(result.sessionId).toBe("sess_learning");
  expect(result.workspaceRoot).toBe(testRoot);
  expect(result.tracePath).toMatch(/sess_learning\.jsonl$/);
  expect(result.stdout).toMatch(/Review Prompts/);
  expect(existsSync(join(testRoot, ".forgelet", "knowledge"))).toBe(false);
});
