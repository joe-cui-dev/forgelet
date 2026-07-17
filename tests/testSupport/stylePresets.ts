import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COMMITTED_CREATIVE_STYLE_PRESETS_PATH } from "../../src/creativeStylePresets/index.js";

export async function writeStylePresetsFixture(
  workspaceRoot: string,
  keys: string[],
): Promise<void> {
  await mkdir(join(workspaceRoot, ".forgelet"), { recursive: true });
  const presets = Object.fromEntries(
    keys.map((key) => [
      key,
      {
        label: `${key} label.`,
        aim: `${key} aim.`,
        instructions: [
          "Instruction one.",
          "Instruction two.",
          "Instruction three.",
        ],
        avoid: ["Avoid one.", "Avoid two."],
        revisionFocus: ["Focus one.", "Focus two."],
      },
    ]),
  );
  await writeFile(
    join(workspaceRoot, COMMITTED_CREATIVE_STYLE_PRESETS_PATH),
    JSON.stringify(presets, null, 2),
    "utf8",
  );
}
