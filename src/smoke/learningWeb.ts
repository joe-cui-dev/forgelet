import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli/index.js";
import { FakeModelClient } from "../models/testing/index.js";

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-learning-web-smoke-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(join(workspaceRoot, ".forgelet", "config.json"), JSON.stringify({ publicWeb: { provider: "fake" } }), "utf8");
  const result = await runCli(["learn", "--web", "summarize the fixture"], {
    workspaceRoot,
    createLiveModelClient: async () => new FakeModelClient([
      { content: "", toolCalls: [{ id: "web_read_fixture", name: "web_read", input: { url: "https://example.test/forgelet-public-web-fixture" } }] },
      { content: "## Summary\nThe fixture is deterministic.\n\n## Key Concepts\n- Public Web sources are ledger-backed.", toolCalls: [] },
    ]),
  });
  if (result.exitCode !== 0 || !result.stdout.includes("- web: https://example.test/forgelet-public-web-fixture"))
    throw new Error(`Learning Web smoke failed.\n${result.stderr}\n${result.stdout}`);
  const sessionDirectory = join(workspaceRoot, ".forgelet", "sessions");
  const traceName = (await readdir(sessionDirectory))[0];
  const traces = await readFile(join(sessionDirectory, traceName ?? ""), "utf8");
  if (!traces.includes('"source":"web"')) throw new Error("Learning Web smoke trace is missing the Web Source.");
  console.log("Learning Web smoke passed.");
}

await main();
