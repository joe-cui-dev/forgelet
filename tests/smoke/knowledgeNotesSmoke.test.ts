import { expect, test } from "@jest/globals";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runKnowledgeNotesSmoke } from "../../src/smoke/knowledgeNotes.js";

test("Knowledge Notes smoke promotes a Learning Session and searches the accepted note", async () => {
  const testRoot = await mkdtemp(
    join(tmpdir(), "forgelet-knowledge-notes-smoke-test-"),
  );
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
      "const command = process.argv[2];",
      "if (command === 'learn') {",
      "  if (!process.argv.includes('--context')) process.exit(20);",
      "  if (!existsSync(join(process.cwd(), 'fixtures', 'learning', 'article.md'))) process.exit(21);",
      "  mkdirSync(join(process.cwd(), '.forgelet', 'sessions'), { recursive: true });",
      "  const tracePath = join(process.cwd(), '.forgelet', 'sessions', 'sess_learning.jsonl');",
      "  const event = (type, payload) => JSON.stringify({ type, sessionId: 'sess_learning', payload });",
      "  writeFileSync(tracePath, [",
      "    event('session_started', { workflow: 'learning' }),",
      "    event('user_task', { task: 'teach me the core ideas' }),",
      "    event('context_attachment', { title: 'article.md', uri: 'fixtures/learning/article.md' }),",
      "    event('routing_selected', { model: 'deepseek-v4-flash', reason: 'default route for learning workflow' }),",
      "    event('final_summary', { summary: 'Summary\\nOk\\n\\nKey Concepts\\nRetrieval practice\\n\\nSource Links\\n- article.md\\n\\nOpen Questions\\nOk\\n\\nReview Prompts\\nOk' }),",
      "    event('session_finished', { status: 'completed' })",
      "  ].join('\\n') + '\\n');",
      "  console.log('Summary\\nOk\\n\\nKey Concepts\\nRetrieval practice\\n\\nSource Links\\n- article.md\\n\\nOpen Questions\\nOk\\n\\nReview Prompts\\nOk');",
      "} else if (command === 'notes' && process.argv[3] === 'create') {",
      "  if (!process.argv.includes('--scope') || !process.argv.includes('project')) process.exit(30);",
      "  if (!process.argv.includes('--from-session') || !process.argv.includes('sess_learning')) process.exit(31);",
      "  mkdirSync(join(process.cwd(), '.forgelet', 'knowledge'), { recursive: true });",
      "  writeFileSync(join(process.cwd(), '.forgelet', 'knowledge', 'teach-me-the-core-ideas-sess_learning.md'), '---\\ntype: knowledge-note\\ntitle: Teach me the core ideas\\nsourceSessionId: sess_learning\\n---\\n\\n# Teach me the core ideas\\n\\nRetrieval practice strengthens memory.\\n');",
      "  console.log('Knowledge Note created\\nPath: .forgelet/knowledge/teach-me-the-core-ideas-sess_learning.md\\nSource Session: sess_learning\\nSources: 1\\nContent hash: abc123');",
      "} else if (command === 'notes' && process.argv[3] === 'search') {",
      "  if (!process.argv.includes('--scope') || !process.argv.includes('project')) process.exit(40);",
      "  if (!process.argv.includes('Retrieval practice')) process.exit(41);",
      "  console.log('Knowledge Notes Search\\nScope: project\\nPath: .forgelet/knowledge\\nQuery: Retrieval practice\\nResults: 1\\n\\n1. Teach me the core ideas\\n   Path: .forgelet/knowledge/teach-me-the-core-ideas-sess_learning.md\\n   Source Session: sess_learning\\n   Snippet: Retrieval practice strengthens memory.');",
      "} else {",
      "  process.exit(50);",
      "}",
    ].join("\n"),
    "utf8",
  );

  const result = await runKnowledgeNotesSmoke({
    cliPath,
    workspaceRoot: testRoot,
    contextPath,
    query: "Retrieval practice",
  });

  expect(result.sessionId).toBe("sess_learning");
  expect(result.notePath).toBe(
    ".forgelet/knowledge/teach-me-the-core-ideas-sess_learning.md",
  );
  expect(result.searchResults).toBe(1);
  expect(result.searchStdout).toMatch(/Retrieval practice/);
  expect(existsSync(join(testRoot, result.notePath))).toBe(true);
  await expect(
    readFile(join(testRoot, result.notePath), "utf8"),
  ).resolves.toMatch(/type: knowledge-note/);
});
