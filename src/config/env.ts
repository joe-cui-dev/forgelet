import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LoadDotEnvInput {
  workspaceRoot?: string;
  path?: string;
  env?: NodeJS.ProcessEnv;
  override?: boolean;
}

export async function loadDotEnv(input: LoadDotEnvInput = {}): Promise<void> {
  const envPath =
    input.path ?? join(input.workspaceRoot ?? process.cwd(), ".env");
  const env = input.env ?? process.env;
  const content = await readOptionalEnvFile(envPath);
  if (!content) return;

  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) continue;
    if (!input.override && env[entry.key] !== undefined) continue;
    env[entry.key] = entry.value;
  }
}

function parseEnvLine(
  line: string,
): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  const separator = normalized.indexOf("=");
  if (separator <= 0) return undefined;

  const key = normalized.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
  return { key, value: parseEnvValue(normalized.slice(separator + 1).trim()) };
}

function parseEnvValue(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"'))
    return raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  const commentIndex = raw.search(/\s#/);
  return (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trimEnd();
}

async function readOptionalEnvFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
}
