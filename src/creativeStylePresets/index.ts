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

export const CREATIVE_STYLE_PRESETS: Record<
  CreativeStyle,
  CreativeStylePreset
> = {
  plain: {
    key: "plain",
    label: "Clear, natural prose with low ornament.",
    aim: "Make the prose easy to follow, direct, and human without sounding flat or mechanical.",
    instructions: [
      "Prefer familiar words and clean sentence shapes.",
      "Keep imagery light unless the brief asks for atmosphere.",
      "Use transitions that make the scene or argument easy to follow.",
    ],
    avoid: [
      "Generic assistant phrasing.",
      "Decorative metaphors that do not clarify the moment.",
      "Overexplaining emotion or intent.",
    ],
    revisionFocus: [
      "Remove clutter while preserving the writer's meaning and voice.",
      "Clarify confusing sentences before adding style.",
    ],
  },
  vivid: {
    key: "vivid",
    label: "Concrete sensory prose with visible action.",
    aim: "Make the scene feel present through specific sensory detail, physical movement, and grounded images.",
    instructions: [
      "Anchor abstractions in concrete sights, sounds, textures, and actions.",
      "Use active verbs and precise nouns before adding adjectives.",
      "Let emotion appear through behavior, setting, and sensory pressure.",
    ],
    avoid: [
      "Stacked adjectives.",
      "Generic mood words without physical evidence.",
      "Sensory detail that slows the scene without changing it.",
    ],
    revisionFocus: [
      "Replace vague summary with observable moments.",
      "Add sensory specificity where the prose feels thin.",
    ],
  },
  tight: {
    key: "tight",
    label: "Tense prose with pressure and suspense.",
    aim: "Create a taut atmosphere where desire, danger, silence, or uncertainty keeps the scene under pressure.",
    instructions: [
      "Let small delays, withheld information, and charged pauses build tension.",
      "Use sentence rhythm to tighten attention around what might happen next.",
      "Keep physical details and dialogue loaded with pressure, risk, or anticipation.",
    ],
    avoid: [
      "Resolving the tension too early.",
      "Confusing tension with generic speed or short sentences.",
      "Melodrama that announces stakes instead of letting the scene carry them.",
    ],
    revisionFocus: [
      "Increase pressure between beats without losing clarity.",
      "Replace flat exposition with charged action, silence, or implication.",
    ],
  },
  literary: {
    key: "literary",
    label: "Layered prose with rhythm and implication.",
    aim: "Give the writing musical rhythm, subtext, and precise imagery without losing clarity.",
    instructions: [
      "Vary sentence length for rhythm and emphasis.",
      "Use images that reveal character, theme, or pressure beneath the surface.",
      "Let some meaning remain implied rather than explained.",
    ],
    avoid: [
      "Purple prose.",
      "Abstract symbolism that floats away from the scene.",
      "Self-conscious language that draws attention to itself.",
    ],
    revisionFocus: [
      "Strengthen rhythm, implication, and image choice.",
      "Cut ornate lines that do not deepen the piece.",
    ],
  },
  cinematic: {
    key: "cinematic",
    label: "Scene-forward prose with camera-ready movement.",
    aim: "Make the writing feel staged, visible, and spatially coherent, as if the reader can watch the scene unfold.",
    instructions: [
      "Track where bodies, objects, and attention move in space.",
      "Use concrete visual beats and controlled cuts between moments.",
      "Prefer action, gesture, and framing before interior explanation.",
    ],
    avoid: [
      "Abstract summary of what the scene means.",
      "Unclear blocking or sudden location jumps.",
      "Explaining feelings before showing visible behavior.",
    ],
    revisionFocus: [
      "Clarify spatial continuity and scene beats.",
      "Turn summary into visible action where useful.",
    ],
  },
  minimal: {
    key: "minimal",
    label: "Restrained prose with silence and white space.",
    aim: "Create force through omission, restraint, and carefully chosen concrete details.",
    instructions: [
      "Use simple sentences and leave room for inference.",
      "Choose one telling detail instead of several decorative ones.",
      "Let silence, gaps, and restraint carry emotional weight.",
    ],
    avoid: [
      "Explaining subtext.",
      "Excessive modifiers.",
      "Sparse prose that becomes vague or empty.",
    ],
    revisionFocus: [
      "Cut explanation and keep the most revealing details.",
      "Preserve ambiguity when it creates useful tension.",
    ],
  },
  lyrical: {
    key: "lyrical",
    label: "Musical prose with heightened rhythm.",
    aim: "Use cadence, image patterns, and sound to make the prose feel fluid and emotionally resonant.",
    instructions: [
      "Shape sentences for cadence and flow.",
      "Use recurring images or sounds when they deepen the mood.",
      "Let rhythm support emotion without obscuring sense.",
    ],
    avoid: [
      "Sing-song phrasing.",
      "Overloaded imagery.",
      "Beautiful lines that blur what is happening.",
    ],
    revisionFocus: [
      "Improve cadence and image continuity.",
      "Cut lyrical excess where clarity drops.",
    ],
  },
  noir: {
    key: "noir",
    label: "Hard-edged prose with shadow and suspicion.",
    aim: "Create a tense, unsentimental atmosphere with sharp observation and moral unease.",
    instructions: [
      "Use concrete urban, nocturnal, or pressure-filled details when they fit the brief.",
      "Keep the voice controlled, skeptical, and observant.",
      "Let tension come from implication, contrast, and withheld trust.",
    ],
    avoid: [
      "Parody detective cliches.",
      "Overusing darkness as decoration.",
      "Melodrama that weakens the threat.",
    ],
    revisionFocus: [
      "Sharpen atmosphere and suspicion.",
      "Remove cliches while keeping the pressure.",
    ],
  },
  warm: {
    key: "warm",
    label: "Generous prose with closeness and care.",
    aim: "Make the writing feel humane, intimate, and emotionally available without becoming sentimental.",
    instructions: [
      "Favor concrete acts of care, attention, and recognition.",
      "Use soft transitions and approachable language.",
      "Let tenderness appear through specific gestures rather than declarations.",
    ],
    avoid: [
      "Sentimentality.",
      "Generic comfort language.",
      "Flattening conflict to keep the tone pleasant.",
    ],
    revisionFocus: [
      "Humanize stiff or distant passages.",
      "Keep emotional clarity while preserving tension.",
    ],
  },
  sharp: {
    key: "sharp",
    label: "Pointed prose with clean edges and judgment.",
    aim: "Make the writing crisp, exact, and memorable through strong choices and controlled bite.",
    instructions: [
      "Use precise verbs, clean syntax, and decisive phrasing.",
      "Let contrast and compression create force.",
      "Keep claims, images, and turns specific enough to land.",
    ],
    avoid: [
      "Bluntness that becomes simplistic.",
      "Snark that distracts from the point.",
      "Over-polished lines that sound brittle.",
    ],
    revisionFocus: [
      "Sharpen weak phrasing and dull transitions.",
      "Cut hedging while preserving nuance.",
    ],
  },
  sensual: {
    key: "sensual",
    label: "Sensory adult prose with desire and restraint.",
    aim: "Create intimate, desire-forward prose through touch, breath, proximity, consent, and sensory escalation without becoming crude or mechanical.",
    instructions: [
      "Ground attraction in specific sensory perception, body language, and mutual attention.",
      "Escalate intimacy through pacing, hesitation, and response rather than explicit inventory.",
      "Keep consent, agency, and emotional context legible in the scene.",
    ],
    avoid: [
      "Clinical body-part listing.",
      "Crude shock value.",
      "Ambiguous consent or coercive framing presented as romance.",
    ],
    revisionFocus: [
      "Make desire feel embodied and reciprocal.",
      "Replace generic heat with precise sensory and emotional beats.",
    ],
  },
  ardent: {
    key: "ardent",
    label: "Passionate adult romance with emotional heat.",
    aim: "Make longing, urgency, and romantic intensity feel consuming while preserving character agency and emotional specificity.",
    instructions: [
      "Tie physical attraction to emotional stakes, memory, conflict, or vulnerability.",
      "Use heightened language for longing and release without losing the scene's concrete action.",
      "Let dialogue, interruption, and hesitation show how badly the characters want what is happening.",
    ],
    avoid: [
      "Soap-opera exaggeration.",
      "Generic lust language.",
      "Passion that erases character boundaries.",
    ],
    revisionFocus: [
      "Raise emotional temperature while keeping motivations clear.",
      "Strengthen the connection between desire, conflict, and choice.",
    ],
  },
};

export function isCreativeStyle(value: string): value is CreativeStyle {
  return CREATIVE_STYLE_PRESET_KEYS.includes(value as CreativeStyle);
}

export function getCreativeStylePreset(
  style: CreativeStyle,
  presets: Record<CreativeStyle, CreativeStylePreset> = CREATIVE_STYLE_PRESETS,
): CreativeStylePreset {
  return presets[style];
}

export async function loadCreativeStylePresets(
  workspaceRoot: string,
): Promise<Record<CreativeStyle, CreativeStylePreset>> {
  const localPresets = await readLocalCreativeStylePresets(workspaceRoot);
  return {
    ...CREATIVE_STYLE_PRESETS,
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
  presets: Record<CreativeStyle, CreativeStylePreset> = CREATIVE_STYLE_PRESETS,
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
