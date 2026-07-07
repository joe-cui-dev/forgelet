import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@jest/globals";
import { runKernelSession } from "../../src/kernel/session.js";

test("kernel source stays workflow-agnostic", async () => {
  const sources = await readTypeScriptSources(
    path.join(process.cwd(), "src/kernel"),
  );

  expect(sources.length).toBeGreaterThan(0);
  for (const source of sources) {
    const contents = await readFile(source, "utf8");
    expect(contents).not.toMatch(/"(coding|writing|learning)"/);
    expect(contents).not.toContain('from "../workflows/');
    expect(contents).not.toContain('from "../writingProjects/');
    expect(contents).not.toContain('from "../creativeStylePresets/');
  }
});

test("kernel exposes a Session entry point", () => {
  expect(typeof runKernelSession).toBe("function");
});

async function readTypeScriptSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return readTypeScriptSources(fullPath);
      if (entry.isFile() && entry.name.endsWith(".ts")) return [fullPath];
      return [];
    }),
  );
  return nested.flat();
}
