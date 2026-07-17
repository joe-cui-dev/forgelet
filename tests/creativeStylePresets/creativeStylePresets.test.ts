import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMITTED_CREATIVE_STYLE_PRESETS_PATH,
  LOCAL_CREATIVE_STYLE_PRESETS_PATH,
  formatCreativeStylePresetForPrompt,
  formatCreativeStylePresetForWorkspacePrompt,
  loadCreativeStylePresets,
} from "../../src/creativeStylePresets/index.js";

function preset(overrides: Partial<Record<string, string | string[]>> = {}) {
  return {
    label: "A label.",
    aim: "An aim.",
    instructions: ["Instruction one.", "Instruction two.", "Instruction three."],
    avoid: ["Avoid one.", "Avoid two."],
    revisionFocus: ["Focus one.", "Focus two."],
    ...overrides,
  };
}

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-style-presets-"));
}

test("formats a creative Style Preset as a distinct prompt block", () => {
  const presets = {
    noir: {
      key: "noir",
      label: "Noir label.",
      aim: "Noir aim.",
      instructions: ["Instruction one.", "Instruction two.", "Instruction three."],
      avoid: ["Avoid one.", "Avoid two."],
      revisionFocus: ["Focus one.", "Focus two."],
    },
  };

  expect(formatCreativeStylePresetForPrompt("noir", presets)).toMatchInlineSnapshot(`
"Style Preset: noir
Label: Noir label.
Aim: Noir aim.
Instructions:
- Instruction one.
- Instruction two.
- Instruction three.
Avoid:
- Avoid one.
- Avoid two.
Revision focus:
- Focus one.
- Focus two."
`);
});

test("throws a clear error when no Style Preset file exists", async () => {
  const workspaceRoot = await makeWorkspace();

  await expect(loadCreativeStylePresets(workspaceRoot)).rejects.toThrow(
    /No Style Preset file found/,
  );
});

test("loads Style Presets from the committed workspace file", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ plain: preset({ label: "Committed plain label." }) }),
    "utf8",
  );

  const presets = await loadCreativeStylePresets(workspaceRoot);
  expect(presets.plain?.label).toBe("Committed plain label.");

  const prompt = await formatCreativeStylePresetForWorkspacePrompt(
    "plain",
    workspaceRoot,
  );
  expect(prompt).toMatch(/Style Preset: plain/);
  expect(prompt).toMatch(/Committed plain label/);
});

test("a local Style Preset file fully shadows the committed file", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ plain: preset(), noir: preset() }),
    "utf8",
  );
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ vivid: preset({ label: "Private vivid label." }) }),
    "utf8",
  );

  const presets = await loadCreativeStylePresets(workspaceRoot);
  expect(Object.keys(presets)).toEqual(["vivid"]);
  expect(presets.vivid?.label).toBe("Private vivid label.");

  await expect(
    formatCreativeStylePresetForWorkspacePrompt("plain", workspaceRoot),
  ).rejects.toThrow(/Unknown Style Preset: plain/);
});

test("rejects an unknown Style Preset key and lists the available ones", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ plain: preset(), noir: preset() }),
    "utf8",
  );

  await expect(
    formatCreativeStylePresetForWorkspacePrompt("gothic", workspaceRoot),
  ).rejects.toThrow(/Unknown Style Preset: gothic.*plain, noir/s);
});

test("accepts non-ASCII Style Preset keys", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ 冷峻: preset({ label: "冷峻风格。" }) }),
    "utf8",
  );

  const prompt = await formatCreativeStylePresetForWorkspacePrompt(
    "冷峻",
    workspaceRoot,
  );
  expect(prompt).toMatch(/Style Preset: 冷峻/);
  expect(prompt).toMatch(/冷峻风格。/);
});

test("rejects a Style Preset key with leading or trailing whitespace", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ " noir": preset() }),
    "utf8",
  );

  await expect(loadCreativeStylePresets(workspaceRoot)).rejects.toThrow(
    /must not have leading or trailing whitespace/,
  );
});

test("rejects a Style Preset missing required fields", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ noir: { label: "Noir label." } }),
    "utf8",
  );

  await expect(loadCreativeStylePresets(workspaceRoot)).rejects.toThrow(
    /preset "noir" aim must be a non-empty string/,
  );
});
