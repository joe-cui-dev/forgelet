import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WorkspaceProfile {
  id: string;
  label: string;
  path: string;
  createdAt: string;
  revokedAt?: string;
}

interface WorkspaceProfileStore {
  profiles: WorkspaceProfile[];
  defaultProfileId: string | null;
}

export interface WorkspaceProfileListing {
  profiles: WorkspaceProfile[];
  defaultProfileId: string | null;
}

export interface ExtensionWorkspaceProfileProjection {
  id: string;
  label: string;
  isDefault: boolean;
}

export function toExtensionWorkspaceProfileProjection(
  listing: WorkspaceProfileListing,
): ExtensionWorkspaceProfileProjection[] {
  return listing.profiles
    .filter((profile) => !profile.revokedAt)
    .map((profile) => ({
      id: profile.id,
      label: profile.label,
      isDefault: profile.id === listing.defaultProfileId,
    }));
}

export async function approveWorkspaceProfile(input: {
  homeDir?: string;
  cwd: string;
  name?: string;
}): Promise<WorkspaceProfile> {
  const canonicalPath = await realpath(input.cwd);
  const store = await readWorkspaceProfileStore(input.homeDir);
  const existing = store.profiles.find((profile) => profile.path === canonicalPath);
  if (existing) return existing;

  const profile: WorkspaceProfile = {
    id: randomUUID(),
    label: input.name ?? canonicalPath,
    path: canonicalPath,
    createdAt: new Date().toISOString(),
  };
  await writeWorkspaceProfileStore(input.homeDir, {
    ...store,
    profiles: [...store.profiles, profile],
  });
  return profile;
}

export async function listWorkspaceProfiles(input: {
  homeDir?: string;
}): Promise<WorkspaceProfileListing> {
  const store = await readWorkspaceProfileStore(input.homeDir);
  return { profiles: store.profiles, defaultProfileId: store.defaultProfileId };
}

export async function setDefaultWorkspaceProfile(input: {
  homeDir?: string;
  profileId: string;
}): Promise<WorkspaceProfile> {
  const store = await readWorkspaceProfileStore(input.homeDir);
  const profile = store.profiles.find((entry) => entry.id === input.profileId);
  if (!profile) {
    throw new Error(`Unknown Workspace Profile: ${input.profileId}`);
  }
  if (profile.revokedAt) {
    throw new Error(`Workspace Profile is revoked: ${input.profileId}`);
  }
  await writeWorkspaceProfileStore(input.homeDir, {
    ...store,
    defaultProfileId: profile.id,
  });
  return profile;
}

export async function resolveWorkspaceProfile(input: {
  homeDir?: string;
  profileId: string;
}): Promise<WorkspaceProfile> {
  const store = await readWorkspaceProfileStore(input.homeDir);
  const profile = store.profiles.find((entry) => entry.id === input.profileId);
  if (!profile) {
    throw new Error(`Unknown Workspace Profile: ${input.profileId}`);
  }
  if (profile.revokedAt) {
    throw new Error(`Workspace Profile is revoked: ${input.profileId}`);
  }
  return profile;
}

export async function revokeWorkspaceProfile(input: {
  homeDir?: string;
  profileId: string;
}): Promise<void> {
  const store = await readWorkspaceProfileStore(input.homeDir);
  const profile = store.profiles.find((entry) => entry.id === input.profileId);
  if (!profile) {
    throw new Error(`Unknown Workspace Profile: ${input.profileId}`);
  }
  if (profile.revokedAt) return;
  const revokedAt = new Date().toISOString();
  await writeWorkspaceProfileStore(input.homeDir, {
    ...store,
    profiles: store.profiles.map((entry) =>
      entry.id === profile.id ? { ...entry, revokedAt } : entry,
    ),
    defaultProfileId:
      store.defaultProfileId === profile.id ? null : store.defaultProfileId,
  });
}

function workspaceProfileStorePath(homeDir?: string): string {
  return join(homeDir ?? homedir(), ".forgelet", "browser", "workspace-profiles.json");
}

async function readWorkspaceProfileStore(
  homeDir: string | undefined,
): Promise<WorkspaceProfileStore> {
  const path = workspaceProfileStorePath(homeDir);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { profiles: [], defaultProfileId: null };
    }
    throw error;
  }
  return parseWorkspaceProfileStore(path, raw);
}

function parseWorkspaceProfileStore(path: string, raw: string): WorkspaceProfileStore {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `Workspace Profile store is corrupt (invalid JSON) at ${path}. Remove or repair the file, then re-run "forge browser profiles approve".`,
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { profiles?: unknown }).profiles)
  ) {
    throw new Error(
      `Workspace Profile store is corrupt (unexpected shape) at ${path}. Remove or repair the file, then re-run "forge browser profiles approve".`,
    );
  }
  const record = value as { profiles: unknown[]; defaultProfileId?: unknown };
  const profiles = record.profiles.map((entry) => parseWorkspaceProfile(path, entry));
  const defaultProfileId =
    typeof record.defaultProfileId === "string" ? record.defaultProfileId : null;
  return { profiles, defaultProfileId };
}

function parseWorkspaceProfile(path: string, entry: unknown): WorkspaceProfile {
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`Workspace Profile store is corrupt (invalid entry) at ${path}.`);
  }
  const record = entry as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.label !== "string" ||
    typeof record.path !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    throw new Error(`Workspace Profile store is corrupt (invalid entry) at ${path}.`);
  }
  return {
    id: record.id,
    label: record.label,
    path: record.path,
    createdAt: record.createdAt,
    ...(typeof record.revokedAt === "string" ? { revokedAt: record.revokedAt } : {}),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

async function writeWorkspaceProfileStore(
  homeDir: string | undefined,
  store: WorkspaceProfileStore,
): Promise<void> {
  const path = workspaceProfileStorePath(homeDir);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}
