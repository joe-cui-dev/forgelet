import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMemoryBlock } from "../../src/memoryReview/renderedMemoryBlock.js";
import { findExistingMemoryBlock } from "../../src/memoryReview/durableMemoryDestination.js";

test("renderMemoryBlock is a single bullet with a trailing provenance marker", () => {
  const rendered = renderMemoryBlock({
    id: "mem_flat",
    text: "In this workspace, search_text matches literal substrings, not regex.",
    sourceSessionId: "sess_flat",
  });

  const expected =
    "- In this workspace, search_text matches literal substrings, not regex. " +
    "<!-- forgelet-memory mem_flat source:sess_flat -->\n";
  expect(rendered.bytes).toBe(expected);
  expect(rendered.finalNewline).toBe(true);
  expect(rendered.byteCount).toBe(Buffer.byteLength(expected, "utf8"));
  expect(rendered.sha256).toBe(createHash("sha256").update(expected).digest("hex"));
  // The flattened block carries no `## id` heading noise.
  expect(rendered.bytes).not.toContain("## ");
  expect(rendered.bytes).not.toContain("Source Session:");
});

async function makeWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-rendered-block-"));
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  return workspaceRoot;
}

test("findExistingMemoryBlock locates a flattened block by its marker", async () => {
  const workspaceRoot = await makeWorkspace();
  const rendered = renderMemoryBlock({
    id: "mem_new",
    text: "Guidance already written.",
    sourceSessionId: "sess_new",
  });
  // Other bullets around it must not confuse the lookup.
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory.md"),
    `- Unrelated hand-written note.\n${rendered.bytes}- Another note.\n`,
    "utf8",
  );

  const found = await findExistingMemoryBlock(
    join(workspaceRoot, ".forgelet", "memory.md"),
    "mem_new",
  );

  expect(found).toEqual({
    blockHash: rendered.sha256,
    blockBytes: rendered.byteCount,
  });
});

test("findExistingMemoryBlock still recognizes a legacy ## heading block", async () => {
  const workspaceRoot = await makeWorkspace();
  const block = "## mem_legacy\n\nLegacy guidance.\n\nSource Session: sess_legacy\n";
  await writeFile(join(workspaceRoot, ".forgelet", "memory.md"), block, "utf8");

  const found = await findExistingMemoryBlock(
    join(workspaceRoot, ".forgelet", "memory.md"),
    "mem_legacy",
  );

  expect(found).toEqual({
    blockHash: createHash("sha256").update(block).digest("hex"),
    blockBytes: Buffer.byteLength(block, "utf8"),
  });
});

test("findExistingMemoryBlock returns undefined when neither shape is present", async () => {
  const workspaceRoot = await makeWorkspace();
  await writeFile(
    join(workspaceRoot, ".forgelet", "memory.md"),
    "- A note without the marker.\n",
    "utf8",
  );

  expect(
    await findExistingMemoryBlock(
      join(workspaceRoot, ".forgelet", "memory.md"),
      "mem_absent",
    ),
  ).toBeUndefined();
});
