import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_CREATIVE_STYLE_PRESETS_PATH,
  formatCreativeStylePresetForPrompt,
  formatCreativeStylePresetForWorkspacePrompt,
  loadCreativeStylePresets,
  validateCreativeStylePresets,
} from "../../src/creativeStylePresets/index.js";
import { BUILT_IN_CREATIVE_STYLE_PRESETS } from "../../src/creativeStylePresets/defaults.js";

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

test("loads all built-in Style Presets when no local file exists", async () => {
  const workspaceRoot = await makeWorkspace();

  await expect(loadCreativeStylePresets(workspaceRoot)).resolves.toEqual(
    BUILT_IN_CREATIVE_STYLE_PRESETS,
  );
});

test("does not expose mutable references to built-in Style Presets", async () => {
  const workspaceRoot = await makeWorkspace();
  const first = await loadCreativeStylePresets(workspaceRoot);
  first.vivid.label = "Mutated label.";
  first.vivid.instructions[0] = "Mutated instruction.";

  const second = await loadCreativeStylePresets(workspaceRoot);
  expect(second.vivid.label).toBe("Concrete sensory prose with visible action.");
  expect(second.vivid.instructions[0]).toBe(
    "Anchor abstractions in concrete sights, sounds, textures, and actions.",
  );
});

test("a local Style Preset adds to the built-in vocabulary", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ custom: preset({ label: "Custom label." }) }),
    "utf8",
  );

  const presets = await loadCreativeStylePresets(workspaceRoot);
  expect(Object.keys(presets)).toHaveLength(11);
  expect(presets.vivid).toEqual(BUILT_IN_CREATIVE_STYLE_PRESETS.vivid);
  expect(presets.custom?.label).toBe("Custom label.");
});

test("a local Style Preset replaces a built-in entry whole", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ vivid: preset({ label: "Private vivid label." }) }),
    "utf8",
  );

  const presets = await loadCreativeStylePresets(workspaceRoot);
  expect(Object.keys(presets)).toHaveLength(10);
  expect(presets.vivid?.label).toBe("Private vivid label.");
  expect(presets.vivid?.aim).toBe("An aim.");
  expect(presets.vivid?.aim).not.toBe(BUILT_IN_CREATIVE_STYLE_PRESETS.vivid.aim);
});

test("rejects an unknown Style Preset key and lists the available ones", async () => {
  const workspaceRoot = await makeWorkspace();
  await expect(
    formatCreativeStylePresetForWorkspacePrompt("gothic", workspaceRoot),
  ).rejects.toThrow(/Unknown Style Preset: gothic.*plain.*sharp/s);
});

test("accepts non-ASCII Style Preset keys", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
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
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
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
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ noir: { label: "Noir label." } }),
    "utf8",
  );

  await expect(loadCreativeStylePresets(workspaceRoot)).rejects.toThrow(
    /preset "noir" aim must be a non-empty string/,
  );
});

test("rejects malformed local JSON instead of falling back to built-ins", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    "{",
    "utf8",
  );

  await expect(loadCreativeStylePresets(workspaceRoot)).rejects.toThrow(
    /Unable to parse .forgelet\/style-presets\.local\.json/,
  );
});

test("an empty local Style Preset file preserves all built-ins", async () => {
  const workspaceRoot = await makeWorkspace();
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    "{}",
    "utf8",
  );

  await expect(loadCreativeStylePresets(workspaceRoot)).resolves.toEqual(
    BUILT_IN_CREATIVE_STYLE_PRESETS,
  );
});

test("the built-in Style Preset roster is stable and every entry passes validation", () => {
  expect(Object.keys(BUILT_IN_CREATIVE_STYLE_PRESETS)).toEqual([
    "plain",
    "vivid",
    "tight",
    "literary",
    "cinematic",
    "minimal",
    "lyrical",
    "noir",
    "warm",
    "sharp",
  ]);

  expect(() =>
    validateCreativeStylePresets(
      "built-in Style Presets",
      BUILT_IN_CREATIVE_STYLE_PRESETS,
    ),
  ).not.toThrow();
});
