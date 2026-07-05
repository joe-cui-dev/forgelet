import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CreativeStyle } from "../types.js";

export interface CreativeStylePreset {
  key: CreativeStyle;
  label: string;
  aim: string;
  instructions: string[];
  avoid: string[];
  revisionFocus: string[];
}

export const CREATIVE_STYLE_PRESET_KEYS = [
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
] as const satisfies readonly CreativeStyle[];

export const LOCAL_CREATIVE_STYLE_PRESETS_PATH =
  ".forgelet/style-presets.local.json";

export const CREATIVE_STYLE_PRESET_LIST = CREATIVE_STYLE_PRESET_KEYS.join(", ");

export const PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS: Record<
  CreativeStyle,
  CreativeStylePreset
> = Object.fromEntries(
  CREATIVE_STYLE_PRESET_KEYS.map((key) => [
    key,
    createPublicFallbackCreativeStylePreset(key),
  ]),
) as Record<CreativeStyle, CreativeStylePreset>;

function createPublicFallbackCreativeStylePreset(
  key: CreativeStyle,
): CreativeStylePreset {
  return {
    key,
    label: `${key} local Style Preset fallback.`,
    aim: `Use the locally configured "${key}" Style Preset when available; otherwise keep the prose clear, coherent, and aligned with the creative brief.`,
    instructions: [
      "Follow the creative brief and any user-provided context closely.",
      "Preserve continuity, point of view, and character agency.",
      "Keep private Style Preset wording in the local ignored preset file, not in source-controlled code.",
    ],
    avoid: [
      "Embedding private local preset text in source-controlled files.",
      "Inventing hidden style rules when the local preset file is missing.",
    ],
    revisionFocus: [
      "Improve clarity, continuity, and specificity.",
      "Keep revisions aligned with the selected Style Preset key and the user's brief.",
    ],
  };
}

export function isCreativeStyle(value: string): value is CreativeStyle {
  return CREATIVE_STYLE_PRESET_KEYS.includes(value as CreativeStyle);
}

export function getCreativeStylePreset(
  style: CreativeStyle,
  presets: Record<CreativeStyle, CreativeStylePreset> =
    PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS,
): CreativeStylePreset {
  return presets[style];
}

export async function loadCreativeStylePresets(
  workspaceRoot: string,
): Promise<Record<CreativeStyle, CreativeStylePreset>> {
  const localPresets = await readLocalCreativeStylePresets(workspaceRoot);
  return {
    ...PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS,
    ...localPresets,
  };
}

export async function formatCreativeStylePresetForWorkspacePrompt(
  style: CreativeStyle,
  workspaceRoot: string,
): Promise<string> {
  const presets = await loadCreativeStylePresets(workspaceRoot);
  return formatCreativeStylePresetForPrompt(style, presets);
}

export function formatCreativeStylePresetForPrompt(
  style: CreativeStyle,
  presets: Record<CreativeStyle, CreativeStylePreset> =
    PUBLIC_CREATIVE_STYLE_PRESET_FALLBACKS,
): string {
  const preset = getCreativeStylePreset(style, presets);
  return [
    `Style Preset: ${preset.key}`,
    `Label: ${preset.label}`,
    `Aim: ${preset.aim}`,
    "Instructions:",
    ...preset.instructions.map((instruction) => `- ${instruction}`),
    "Avoid:",
    ...preset.avoid.map((rule) => `- ${rule}`),
    "Revision focus:",
    ...preset.revisionFocus.map((focus) => `- ${focus}`),
  ].join("\n");
}

async function readLocalCreativeStylePresets(
  workspaceRoot: string,
): Promise<Partial<Record<CreativeStyle, CreativeStylePreset>>> {
  const path = join(workspaceRoot, LOCAL_CREATIVE_STYLE_PRESETS_PATH);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to parse ${LOCAL_CREATIVE_STYLE_PRESETS_PATH}: ${message}`,
    );
  }

  if (!isRecord(parsed))
    throw new Error(
      `${LOCAL_CREATIVE_STYLE_PRESETS_PATH} must contain a JSON object keyed by creative Style Preset.`,
    );

  const presets: Partial<Record<CreativeStyle, CreativeStylePreset>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isCreativeStyle(key))
      throw new Error(
        `Unknown creative Style Preset in ${LOCAL_CREATIVE_STYLE_PRESETS_PATH}: ${key}. Expected one of: ${CREATIVE_STYLE_PRESET_LIST}`,
      );
    presets[key] = validateLocalCreativeStylePreset(key, value);
  }
  return presets;
}

function validateLocalCreativeStylePreset(
  key: CreativeStyle,
  value: unknown,
): CreativeStylePreset {
  if (!isRecord(value))
    throw localPresetError(key, "must be a JSON object.");
  const localKey = value.key;
  if (localKey !== undefined && localKey !== key)
    throw localPresetError(key, `must not declare a different key: ${localKey}`);

  return {
    key,
    label: readRequiredString(key, value, "label"),
    aim: readRequiredString(key, value, "aim"),
    instructions: readRequiredStringArray(key, value, "instructions", 3),
    avoid: readRequiredStringArray(key, value, "avoid", 2),
    revisionFocus: readRequiredStringArray(key, value, "revisionFocus", 2),
  };
}

function readRequiredString(
  key: CreativeStyle,
  record: Record<string, unknown>,
  field: keyof Omit<CreativeStylePreset, "key">,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0)
    throw localPresetError(key, `${field} must be a non-empty string.`);
  return value;
}

function readRequiredStringArray(
  key: CreativeStyle,
  record: Record<string, unknown>,
  field: keyof Omit<CreativeStylePreset, "key">,
  minimumLength: number,
): string[] {
  const value = record[field];
  if (
    !Array.isArray(value) ||
    value.length < minimumLength ||
    value.some((item) => typeof item !== "string" || item.trim().length === 0)
  )
    throw localPresetError(
      key,
      `${field} must contain at least ${minimumLength} non-empty strings.`,
    );
  return value;
}

function localPresetError(key: CreativeStyle, detail: string): Error {
  return new Error(
    `${LOCAL_CREATIVE_STYLE_PRESETS_PATH} preset "${key}" ${detail}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
