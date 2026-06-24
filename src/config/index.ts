import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { WorkflowKind } from "../types.js";

export interface RoutingConfig {
  coding: StageRoutingConfig;
  writing: StageRoutingConfig;
  fallback: string;
}

export interface StageRoutingConfig {
  default: string;
  review: string;
}

export interface ProviderSettings {
  apiKeyEnv: string;
}

export interface ForgeletConfig {
  defaultModel: string;
  fallbackModel: string;
  cheapModel: string;
  routing: RoutingConfig;
  providers: {
    deepseek: ProviderSettings;
    openai: ProviderSettings;
    anthropic: ProviderSettings;
  };
  budgets: {
    maxModelTurns: number;
    maxInputTokens: number;
    maxEstimatedCostUsd: number;
  };
  activeContext: {
    maxObservationBytes: number;
  };
  safeCommands: string[];
  testCommands: string[];
  commandTimeoutMs: number;
  maxPatchBytes: number;
  memoryFile: string;
}

type WritableConfig = Partial<Omit<ForgeletConfig, "providers">> & {
  providers?: {
    deepseek?: Partial<ProviderSettings>;
    openai?: Partial<ProviderSettings>;
    anthropic?: Partial<ProviderSettings>;
  };
};

export const defaultConfig: ForgeletConfig = {
  defaultModel: "deepseek-v4-flash",
  fallbackModel: "gpt-5",
  cheapModel: "deepseek-v4-flash",
  routing: {
    coding: {
      default: "deepseek-v4-flash",
      review: "deepseek-v4-flash",
    },
    writing: {
      default: "deepseek-v4-flash",
      review: "deepseek-v4-flash",
    },
    fallback: "gpt-5",
  },
  providers: {
    deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY" },
    openai: { apiKeyEnv: "OPENAI_API_KEY" },
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
  budgets: {
    maxModelTurns: 12,
    maxInputTokens: 120000,
    maxEstimatedCostUsd: 1.0,
  },
  activeContext: {
    maxObservationBytes: 16 * 1024,
  },
  safeCommands: ["npm test", "npm run build", "npm run typecheck", "npx jest"],
  testCommands: ["npm test", "npm run build", "npm run typecheck"],
  commandTimeoutMs: 60_000,
  maxPatchBytes: 100 * 1024,
  memoryFile: ".forgelet/memory.md",
};

export interface LoadConfigInput {
  homeDir?: string;
  workspaceRoot: string;
}

export interface SetConfigValueInput {
  homeDir?: string;
  key: string;
  value: string;
}

export async function loadConfig(
  input: LoadConfigInput,
): Promise<ForgeletConfig> {
  const homeConfig = await readOptionalJson(globalConfigPath(input.homeDir));
  const projectConfig = await readOptionalJson(
    join(input.workspaceRoot, ".forgelet", "config.json"),
  );
  const config = mergeConfig(
    mergeConfig(defaultConfig, homeConfig),
    projectConfig,
  );
  validateConfig(config);
  return config;
}

export async function setGlobalConfigValue(
  input: SetConfigValueInput,
): Promise<void> {
  const path = globalConfigPath(input.homeDir);
  const current = await readOptionalJson(path);
  const next = applySupportedConfigValue(current, input.key, input.value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function routeModel(
  config: ForgeletConfig,
  workflow: WorkflowKind,
  modelOverride?: string,
): { model: string; reason: string } {
  if (modelOverride)
    return { model: modelOverride, reason: "CLI model override" };
  return {
    model: config.routing[workflow].default,
    reason: `default route for ${workflow} workflow`,
  };
}

function applySupportedConfigValue(
  config: WritableConfig,
  key: string,
  value: string,
): WritableConfig {
  if (key === "memoryFile") return { ...config, memoryFile: value };
  if (key === "activeContext.maxObservationBytes") {
    const maxObservationBytes = Number(value);
    if (
      !Number.isFinite(maxObservationBytes) ||
      !Number.isInteger(maxObservationBytes) ||
      maxObservationBytes < 4_096
    )
      throw new Error(
        "activeContext.maxObservationBytes must be a finite integer of at least 4096.",
      );
    return {
      ...config,
      activeContext: {
        ...config.activeContext,
        maxObservationBytes,
      },
    };
  }
  if (key === "providers.deepseek.apiKeyEnv")
    return {
      ...config,
      providers: {
        ...config.providers,
        deepseek: { ...config.providers?.deepseek, apiKeyEnv: value },
      },
    };
  if (key === "providers.openai.apiKeyEnv")
    return {
      ...config,
      providers: {
        ...config.providers,
        openai: { ...config.providers?.openai, apiKeyEnv: value },
      },
    };
  if (key === "providers.anthropic.apiKeyEnv")
    return {
      ...config,
      providers: {
        ...config.providers,
        anthropic: { ...config.providers?.anthropic, apiKeyEnv: value },
      },
    };
  throw new Error(
    [
      `Unsupported config key for V1: ${key}`,
      "Supported keys: memoryFile, activeContext.maxObservationBytes, providers.deepseek.apiKeyEnv, providers.openai.apiKeyEnv, providers.anthropic.apiKeyEnv",
    ].join("\n"),
  );
}

function mergeConfig(
  base: ForgeletConfig,
  override: WritableConfig,
): ForgeletConfig {
  return {
    ...base,
    defaultModel: defaultConfig.defaultModel,
    fallbackModel: defaultConfig.fallbackModel,
    cheapModel: defaultConfig.cheapModel,
    routing: defaultConfig.routing,
    providers: {
      ...base.providers,
      ...override.providers,
      deepseek: { ...base.providers.deepseek, ...override.providers?.deepseek },
      openai: { ...base.providers.openai, ...override.providers?.openai },
      anthropic: {
        ...base.providers.anthropic,
        ...override.providers?.anthropic,
      },
    },
    budgets: {
      ...base.budgets,
      ...override.budgets,
    },
    activeContext: {
      ...base.activeContext,
      ...override.activeContext,
    },
    safeCommands: override.safeCommands ?? base.safeCommands,
    testCommands: override.testCommands ?? base.testCommands,
    commandTimeoutMs: override.commandTimeoutMs ?? base.commandTimeoutMs,
    maxPatchBytes: override.maxPatchBytes ?? base.maxPatchBytes,
    memoryFile: override.memoryFile ?? base.memoryFile,
  };
}

function validateConfig(config: ForgeletConfig): void {
  const maxObservationBytes = config.activeContext.maxObservationBytes;
  if (
    !Number.isFinite(maxObservationBytes) ||
    !Number.isInteger(maxObservationBytes) ||
    maxObservationBytes < 4_096
  )
    throw new Error(
      "activeContext.maxObservationBytes must be a finite integer of at least 4096.",
    );
}

async function readOptionalJson(path: string): Promise<WritableConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as WritableConfig;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return {};
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON config: ${path}`);
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function globalConfigPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".forgelet", "config.json");
}
