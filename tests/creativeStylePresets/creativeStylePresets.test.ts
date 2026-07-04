import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREATIVE_STYLE_PRESET_KEYS,
  CREATIVE_STYLE_PRESETS,
  LOCAL_CREATIVE_STYLE_PRESETS_PATH,
  formatCreativeStylePresetForPrompt,
  formatCreativeStylePresetForWorkspacePrompt,
  loadCreativeStylePresets,
} from "../../src/creativeStylePresets/index.js";

test("defines all built-in creative Style Presets with prompt-ready guidance", () => {
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
    const preset = CREATIVE_STYLE_PRESETS[key];
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

test("treats tight as tense atmosphere rather than compressed prose", () => {
  const prompt = formatCreativeStylePresetForPrompt("tight");

  expect(prompt).toMatch(/Style Preset: tight/);
  expect(prompt).toMatch(/Tense prose with pressure and suspense/);
  expect(prompt).toMatch(/charged pauses build tension/);
  expect(prompt).not.toMatch(/Compressed prose/);
  expect(prompt).not.toMatch(/Cut slack/);
});

test("formats a creative Style Preset as a distinct prompt block", () => {
  expect(formatCreativeStylePresetForPrompt("noir")).toMatchInlineSnapshot(`
"Style Preset: noir
Label: Hard-edged prose with shadow and suspicion.
Aim: Create a tense, unsentimental atmosphere with sharp observation and moral unease.
Instructions:
- Use concrete urban, nocturnal, or pressure-filled details when they fit the brief.
- Keep the voice controlled, skeptical, and observant.
- Let tension come from implication, contrast, and withheld trust.
Avoid:
- Parody detective cliches.
- Overusing darkness as decoration.
- Melodrama that weakens the threat.
Revision focus:
- Sharpen atmosphere and suspicion.
- Remove cliches while keeping the pressure."
`);
});

test("loads local creative Style Preset overrides from the ignored project file", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-style-presets-"));
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
  expect(presets.plain.label).toBe(CREATIVE_STYLE_PRESETS.plain.label);

  const prompt = await formatCreativeStylePresetForWorkspacePrompt(
    "vivid",
    workspaceRoot,
  );
  expect(prompt).toMatch(/Style Preset: vivid/);
  expect(prompt).toMatch(/Private vivid label/);
  expect(prompt).toMatch(/Private instruction three/);
});

test("rejects unknown local creative Style Preset keys", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "forgelet-style-presets-"));
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
