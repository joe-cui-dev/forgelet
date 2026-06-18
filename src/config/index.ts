import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
  safeCommands: string[];
  testCommands: string[];
  memoryFile: string;
}

export const defaultConfig: ForgeletConfig = {
  defaultModel: "deepseek-v4-pro",
  fallbackModel: "gpt-5",
  cheapModel: "deepseek-v4-flash",
  routing: {
    coding: {
      default: "deepseek-v4-pro",
      review: "deepseek-v4-pro",
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
  safeCommands: ["npm test", "npm run build", "npx jest"],
  testCommands: ["npm test", "npm run build"],
  memoryFile: ".forgelet/memory.md",
};

export interface LoadConfigInput {
  homeDir?: string;
  workspaceRoot: string;
}

export async function loadConfig(
  input: LoadConfigInput,
): Promise<ForgeletConfig> {
  const homeConfig = await readOptionalJson(
    join(input.homeDir ?? homedir(), ".forgelet", "config.json"),
  );
  const projectConfig = await readOptionalJson(
    join(input.workspaceRoot, ".forgelet", "config.json"),
  );
  return mergeConfig(mergeConfig(defaultConfig, homeConfig), projectConfig);
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

function mergeConfig(
  base: ForgeletConfig,
  override: Partial<ForgeletConfig>,
): ForgeletConfig {
  return {
    ...base,
    ...override,
    routing: {
      ...base.routing,
      ...override.routing,
      coding: { ...base.routing.coding, ...override.routing?.coding },
      writing: { ...base.routing.writing, ...override.routing?.writing },
    },
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
    safeCommands: override.safeCommands ?? base.safeCommands,
    testCommands: override.testCommands ?? base.testCommands,
    memoryFile: override.memoryFile ?? base.memoryFile,
  };
}

async function readOptionalJson(
  path: string,
): Promise<Partial<ForgeletConfig>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Partial<ForgeletConfig>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    if (error instanceof SyntaxError)
      throw new Error(`Invalid JSON config: ${path}`);
    throw error;
  }
}
