import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { loadConfig, routeModel } from "../config/index.js";
import { loadDotEnv } from "../config/env.js";
import { DeepSeekModelClient } from "../models/providers/deepseek.js";
import type {
  ModelClient,
  ModelTurnInput,
  ModelTurnOutput,
  WorkflowKind,
} from "../types.js";
import type { ApprovalHandler, ApprovalRequest } from "../tools/toolRegistry.js";

export interface CreateLiveModelClientInput {
  workflow: WorkflowKind;
  modelOverride?: string;
  homeDir?: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
}

export async function createDeepSeekLiveModelClient(
  input: CreateLiveModelClientInput,
): Promise<ModelClient> {
  await loadDotEnv({ workspaceRoot: input.workspaceRoot, env: input.env });
  const config = await loadConfig({
    homeDir: input.homeDir,
    workspaceRoot: input.workspaceRoot,
  });
  const route = routeModel(config, input.workflow, input.modelOverride);
  if (!route.model.startsWith("deepseek-")) {
    throw new Error(
      `Model-backed execution currently supports DeepSeek models only. Route selected ${route.model}.`,
    );
  }
  const apiKeyEnv = config.providers.deepseek.apiKeyEnv;
  const apiKey = input.env[apiKeyEnv];
  if (!apiKey)
    throw new Error(
      `${apiKeyEnv} is required for model-backed Sessions. Set it in .env, or run forge code --preview "<task>" to inspect routing without calling a model.`,
    );
  return new DeepSeekModelClient({ apiKey, model: route.model });
}

export function createDeferredLiveModelClient(
  input: CreateLiveModelClientInput,
  factory: (input: CreateLiveModelClientInput) => Promise<ModelClient>,
): ModelClient {
  let clientPromise: Promise<ModelClient> | undefined;
  return {
    createTurn: async (
      turnInput: ModelTurnInput,
    ): Promise<ModelTurnOutput> => {
      clientPromise ??= factory(input);
      const client = await clientPromise;
      return client.createTurn(turnInput);
    },
  };
}

export function createTerminalApprovalHandler(): ApprovalHandler {
  return async (request) => {
    const prompt = formatApprovalPrompt(request);
    const readline = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      let answer = await readline.question(`${prompt}\nApprove? [y/N${request.toolCall.name === "apply_patch" ? "/s" : ""}] `);
      if (request.toolCall.name === "apply_patch" && answer.toLowerCase() === "s") {
        const patch = isRecord(request.toolCall.input) && typeof request.toolCall.input.patch === "string"
          ? request.toolCall.input.patch
          : "";
        if (patch) process.stderr.write(`\n${patch}\n`);
        answer = await readline.question("Approve? [y/N] ");
        return {
          status: answer.toLowerCase() === "y" ? "approved" : "rejected",
          reason: answer.toLowerCase() === "y" ? "Approved by user." : "Rejected by user.",
          fullPatchShown: true,
        };
      }
      return {
        status: answer.toLowerCase() === "y" ? "approved" : "rejected",
        reason: answer.toLowerCase() === "y" ? "Approved by user." : "Rejected by user.",
        fullPatchShown: false,
      };
    } finally {
      readline.close();
    }
  };
}

export function formatApprovalPrompt(request: ApprovalRequest): string {
  if (request.toolCall.name === "run_command") {
    const command = isRecord(request.toolCall.input) && typeof request.toolCall.input.command === "string"
      ? request.toolCall.input.command
      : "(unknown command)";
    return [
      "Forgelet requests approval to run a configured command.",
      `Command: ${command}`,
      `Workspace: ${request.toolRequest.workspaceRoot}`,
      `Reason: ${request.permissionDecision.reason}`,
    ].join("\n");
  }
  if (request.toolCall.name === "apply_patch") {
    const patch = isRecord(request.toolCall.input) && typeof request.toolCall.input.patch === "string"
      ? request.toolCall.input.patch
      : "";
    const hash = patch ? hashText(patch) : "(unknown)";
    const files = request.toolRequest.targets
      ?.filter((target) => target.kind === "path")
      .map((target) => target.path)
      .join(", ") || "(unknown)";
    return [
      "Forgelet requests approval to apply a patch.",
      `Changed files: ${files}`,
      `Patch hash: ${hash}`,
      `Preview:\n${patch.slice(0, 1_000)}`,
      `Reason: ${request.permissionDecision.reason}`,
      "Enter s to show the full patch before deciding.",
    ].join("\n");
  }
  return [
    `Forgelet requests approval for ${request.toolCall.name}.`,
    `Reason: ${request.permissionDecision.reason}`,
  ].join("\n");
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};
