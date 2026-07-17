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

export const COMMITTED_CREATIVE_STYLE_PRESETS_PATH =
  ".forgelet/style-presets.json";

export const LOCAL_CREATIVE_STYLE_PRESETS_PATH =
  ".forgelet/style-presets.local.json";

export async function loadCreativeStylePresets(
  workspaceRoot: string,
): Promise<Record<string, CreativeStylePreset>> {
  const local = await readCreativeStylePresetFile(
    workspaceRoot,
    LOCAL_CREATIVE_STYLE_PRESETS_PATH,
  );
  if (local) return local;
  const committed = await readCreativeStylePresetFile(
    workspaceRoot,
    COMMITTED_CREATIVE_STYLE_PRESETS_PATH,
  );
  if (committed) return committed;
  throw new Error(
    `No Style Preset file found. Create ${COMMITTED_CREATIVE_STYLE_PRESETS_PATH} or ${LOCAL_CREATIVE_STYLE_PRESETS_PATH} to define Style Presets.`,
  );
}

export function getCreativeStylePreset(
  style: CreativeStyle,
  presets: Record<string, CreativeStylePreset>,
): CreativeStylePreset {
  const preset = presets[style];
  if (!preset)
    throw new Error(
      `Unknown Style Preset: ${style}. Available: ${
        Object.keys(presets).join(", ") || "(none)"
      }`,
    );
  return preset;
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
  presets: Record<string, CreativeStylePreset>,
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

async function readCreativeStylePresetFile(
  workspaceRoot: string,
  relativePath: string,
): Promise<Record<string, CreativeStylePreset> | undefined> {
  const path = join(workspaceRoot, relativePath);
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse ${relativePath}: ${message}`);
  }

  if (!isRecord(parsed))
    throw new Error(
      `${relativePath} must contain a JSON object keyed by Style Preset name.`,
    );

  const presets: Record<string, CreativeStylePreset> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key.trim().length === 0)
      throw new Error(`${relativePath} has a blank Style Preset key.`);
    if (key.trim() !== key)
      throw new Error(
        `${relativePath} Style Preset key must not have leading or trailing whitespace: "${key}"`,
      );
    presets[key] = validateCreativeStylePreset(relativePath, key, value);
  }
  return presets;
}

function validateCreativeStylePreset(
  relativePath: string,
  key: string,
  value: unknown,
): CreativeStylePreset {
  if (!isRecord(value))
    throw presetError(relativePath, key, "must be a JSON object.");
  const declaredKey = value.key;
  if (declaredKey !== undefined && declaredKey !== key)
    throw presetError(
      relativePath,
      key,
      `must not declare a different key: ${declaredKey}`,
    );

  return {
    key,
    label: readRequiredString(relativePath, key, value, "label"),
    aim: readRequiredString(relativePath, key, value, "aim"),
    instructions: readRequiredStringArray(
      relativePath,
      key,
      value,
      "instructions",
      3,
    ),
    avoid: readRequiredStringArray(relativePath, key, value, "avoid", 2),
    revisionFocus: readRequiredStringArray(
      relativePath,
      key,
      value,
      "revisionFocus",
      2,
    ),
  };
}

function readRequiredString(
  relativePath: string,
  key: string,
  record: Record<string, unknown>,
  field: keyof Omit<CreativeStylePreset, "key">,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0)
    throw presetError(relativePath, key, `${field} must be a non-empty string.`);
  return value;
}

function readRequiredStringArray(
  relativePath: string,
  key: string,
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
    throw presetError(
      relativePath,
      key,
      `${field} must contain at least ${minimumLength} non-empty strings.`,
    );
  return value;
}

function presetError(relativePath: string, key: string, detail: string): Error {
  return new Error(`${relativePath} preset "${key}" ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
