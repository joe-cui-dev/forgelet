import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREATIVE_STYLE_PRESET_KEYS,
  LOCAL_CREATIVE_STYLE_PRESETS_PATH,
  PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS,
  formatCreativeStylePresetForPrompt,
  formatCreativeStylePresetForWorkspacePrompt,
  loadCreativeStylePresets,
} from "../../src/creativeStylePresets/index.js";

test("defines all creative Style Preset keys with public fallback guidance", () => {
  expect(CREATIVE_STYLE_PRESET_KEYS).toEqual([
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
    "sensual",
    "ardent",
  ]);

  for (const key of CREATIVE_STYLE_PRESET_KEYS) {
    const preset = PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS[key];
    expect(preset.key).toBe(key);
    expect(preset.label).toEqual(expect.any(String));
    expect(preset.label.length).toBeGreaterThan(0);
    expect(preset.aim).toEqual(expect.any(String));
    expect(preset.aim.length).toBeGreaterThan(0);
    expect(preset.instructions.length).toBeGreaterThanOrEqual(3);
    expect(preset.avoid.length).toBeGreaterThanOrEqual(2);
    expect(preset.revisionFocus.length).toBeGreaterThanOrEqual(2);
  }
});

test("keeps source-controlled fallbacks free of private preset prose", () => {
  const prompt = formatCreativeStylePresetForPrompt("tight");

  expect(prompt).toMatch(/Style Preset: tight/);
  expect(prompt).toMatch(/local Style Preset fallback/);
  expect(prompt).toMatch(/local ignored preset file/);
  expect(prompt).not.toMatch(/private prose marker/);
});

test("formats a creative Style Preset as a distinct prompt block", () => {
  expect(formatCreativeStylePresetForPrompt("noir")).toMatchInlineSnapshot(`
"Style Preset: noir
Label: noir local Style Preset fallback.
Aim: Use the locally configured "noir" Style Preset when available; otherwise keep the prose clear, coherent, and aligned with the creative brief.
Instructions:
- Follow the creative brief and any user-provided context closely.
- Preserve continuity, point of view, and character agency.
- Keep private Style Preset wording in the local ignored preset file, not in source-controlled code.
Avoid:
- Embedding private local preset text in source-controlled files.
- Inventing hidden style rules when the local preset file is missing.
Revision focus:
- Improve clarity, continuity, and specificity.
- Keep revisions aligned with the selected Style Preset key and the user's brief."
`);
});

test("loads local creative Style Preset overrides from the ignored project file", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-style-presets-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify(
      {
        vivid: {
          label: "Private vivid label.",
          aim: "Private vivid aim.",
          instructions: [
            "Private instruction one.",
            "Private instruction two.",
            "Private instruction three.",
          ],
          avoid: ["Private avoid one.", "Private avoid two."],
          revisionFocus: [
            "Private revision focus one.",
            "Private revision focus two.",
          ],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const presets = await loadCreativeStylePresets(workspaceRoot);
  expect(presets.vivid.label).toBe("Private vivid label.");
  expect(presets.plain.label).toBe(
    PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS.plain.label,
  );

  const prompt = await formatCreativeStylePresetForWorkspacePrompt(
    "vivid",
    workspaceRoot,
  );
  expect(prompt).toMatch(/Style Preset: vivid/);
  expect(prompt).toMatch(/Private vivid label/);
  expect(prompt).toMatch(/Private instruction three/);
});

test("rejects unknown local creative Style Preset keys", async () => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "forgelet-style-presets-"),
  );
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  await writeFile(
    join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify({ foggy: {} }),
    "utf8",
  );

  await expect(loadCreativeStylePresets(workspaceRoot)).rejects.toThrow(
    /Unknown creative Style Preset.*foggy/,
  );
});
