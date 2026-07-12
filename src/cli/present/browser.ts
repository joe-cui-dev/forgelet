import type { LoadedBrowserSnapshot } from "../../browser/index.js";
import type {
  WorkspaceProfile,
  WorkspaceProfileListing,
} from "../../browser/workspaceProfiles.js";

export function formatBrowserSnapshot(snapshot: LoadedBrowserSnapshot): string {
  return [
    "Browser Context Snapshot",
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Captured at: ${snapshot.capturedAt}`,
    `Content: ${snapshot.contentKind}`,
    `Content bytes: ${snapshot.contentBytes}`,
    `Content hash: ${snapshot.contentHash}`,
    `Preview: ${snapshot.preview}`,
    ...(snapshot.screenshotPath ? [`Screenshot path: ${snapshot.screenshotPath}`] : []),
  ].join("\n");
}

export function formatApprovedWorkspaceProfile(profile: WorkspaceProfile): string {
  return [
    "Workspace Profile approved",
    `ID: ${profile.id}`,
    `Label: ${profile.label}`,
    `Path: ${profile.path}`,
  ].join("\n");
}

export function formatWorkspaceProfileList(listing: WorkspaceProfileListing): string {
  if (listing.profiles.length === 0) {
    return "No Workspace Profiles are approved yet. Approve one with: forge browser profiles approve";
  }
  const lines = listing.profiles.map((profile) => {
    const tags = [
      profile.id === listing.defaultProfileId ? "default" : undefined,
      profile.revokedAt ? "revoked" : undefined,
    ].filter((tag): tag is string => tag !== undefined);
    const suffix = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    return `- ${profile.label} [${profile.id}]${suffix} — ${profile.path}`;
  });
  return ["Workspace Profiles", ...lines].join("\n");
}

export function formatSetDefaultWorkspaceProfile(profile: WorkspaceProfile): string {
  return `Workspace Profile set as default: ${profile.label} [${profile.id}]`;
}

export function formatRevokedWorkspaceProfile(profileId: string): string {
  return `Workspace Profile revoked: ${profileId}`;
}

export function formatInstalledChromeNativeHost(input: {
  manifestPath: string;
  hostPath: string;
  extensionId: string;
}): string {
  return [
    "Chrome Native Messaging host installed",
    `Extension id: ${input.extensionId}`,
    `Manifest: ${input.manifestPath}`,
    `Host: ${input.hostPath}`,
  ].join("\n");
}
