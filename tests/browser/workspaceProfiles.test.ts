import { expect, test } from "@jest/globals";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveWorkspaceProfile,
  listWorkspaceProfiles,
  resolveWorkspaceProfile,
  revokeWorkspaceProfile,
  setDefaultWorkspaceProfile,
  toExtensionWorkspaceProfileProjection,
} from "../../src/browser/workspaceProfiles.js";

async function makeHomeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-wsprofiles-home-"));
}

async function makeCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), "forgelet-wsprofiles-cwd-"));
}

test("approving the current cwd creates a stable profile with opaque id, label, canonical path, and timestamp", async () => {
  const homeDir = await makeHomeDir();
  const cwd = await makeCwd();
  const canonicalCwd = await realpath(cwd);

  const profile = await approveWorkspaceProfile({
    homeDir,
    cwd,
    name: "My Repo",
  });

  expect(typeof profile.id).toBe("string");
  expect(profile.id.length).toBeGreaterThan(0);
  expect(profile.label).toBe("My Repo");
  expect(profile.path).toBe(canonicalCwd);
  expect(typeof profile.createdAt).toBe("string");
  expect(Number.isFinite(Date.parse(profile.createdAt))).toBe(true);
});

test("re-approving the same canonical path is idempotent and does not duplicate it", async () => {
  const homeDir = await makeHomeDir();
  const cwd = await makeCwd();

  const first = await approveWorkspaceProfile({ homeDir, cwd, name: "First" });
  const second = await approveWorkspaceProfile({ homeDir, cwd, name: "Second" });

  expect(second.id).toBe(first.id);

  const { profiles } = await listWorkspaceProfiles({ homeDir });
  expect(profiles).toHaveLength(1);
  expect(profiles[0]?.id).toBe(first.id);
});

test("symlink-equivalent paths resolve to the same profile", async () => {
  const homeDir = await makeHomeDir();
  const realCwd = await makeCwd();
  const parentDir = await mkdtemp(join(tmpdir(), "forgelet-wsprofiles-link-parent-"));
  const linkPath = join(parentDir, "link-to-cwd");
  await symlink(realCwd, linkPath);

  const viaReal = await approveWorkspaceProfile({ homeDir, cwd: realCwd });
  const viaSymlink = await approveWorkspaceProfile({ homeDir, cwd: linkPath });

  expect(viaSymlink.id).toBe(viaReal.id);

  const { profiles } = await listWorkspaceProfiles({ homeDir });
  expect(profiles).toHaveLength(1);
});

test("list marks exactly one default when configured", async () => {
  const homeDir = await makeHomeDir();
  const cwdA = await makeCwd();
  const cwdB = await makeCwd();

  const profileA = await approveWorkspaceProfile({ homeDir, cwd: cwdA, name: "A" });
  const profileB = await approveWorkspaceProfile({ homeDir, cwd: cwdB, name: "B" });

  const beforeDefault = await listWorkspaceProfiles({ homeDir });
  expect(beforeDefault.defaultProfileId).toBeNull();

  await setDefaultWorkspaceProfile({ homeDir, profileId: profileB.id });

  const { profiles, defaultProfileId } = await listWorkspaceProfiles({ homeDir });
  expect(defaultProfileId).toBe(profileB.id);
  expect(profiles.map((profile) => profile.id)).toEqual([profileA.id, profileB.id]);
});

test("set-default rejects an unknown profile", async () => {
  const homeDir = await makeHomeDir();
  await expect(
    setDefaultWorkspaceProfile({ homeDir, profileId: "does-not-exist" }),
  ).rejects.toThrow(/Unknown Workspace Profile/);
});

test("set-default rejects a revoked profile", async () => {
  const homeDir = await makeHomeDir();
  const cwd = await makeCwd();
  const profile = await approveWorkspaceProfile({ homeDir, cwd });

  await revokeWorkspaceProfile({ homeDir, profileId: profile.id });

  await expect(
    setDefaultWorkspaceProfile({ homeDir, profileId: profile.id }),
  ).rejects.toThrow(/revoked/i);
});

test("revoke blocks later resolution but does not mutate already-resolved launch evidence", async () => {
  const homeDir = await makeHomeDir();
  const cwd = await makeCwd();
  const approved = await approveWorkspaceProfile({ homeDir, cwd, name: "Repo" });

  const resolvedBeforeRevoke = await resolveWorkspaceProfile({
    homeDir,
    profileId: approved.id,
  });
  expect(resolvedBeforeRevoke).toEqual(approved);

  await revokeWorkspaceProfile({ homeDir, profileId: approved.id });

  await expect(
    resolveWorkspaceProfile({ homeDir, profileId: approved.id }),
  ).rejects.toThrow(/revoked/i);

  // Evidence already captured for a launch before the revoke is untouched.
  expect(resolvedBeforeRevoke).toEqual(approved);
});

test("corrupt profile storage fails closed with an actionable error", async () => {
  const homeDir = await makeHomeDir();
  const cwd = await makeCwd();
  const storeDir = join(homeDir, ".forgelet", "browser");
  await mkdir(storeDir, { recursive: true });
  await writeFile(
    join(storeDir, "workspace-profiles.json"),
    "{ not valid json",
    "utf8",
  );

  await expect(listWorkspaceProfiles({ homeDir })).rejects.toThrow(
    /Workspace Profile store is corrupt/,
  );
  await expect(
    approveWorkspaceProfile({ homeDir, cwd, name: "Repo" }),
  ).rejects.toThrow(/Workspace Profile store is corrupt/);
});

test("extension-facing profile projection returns only id, label, and default status", async () => {
  const homeDir = await makeHomeDir();
  const cwdA = await makeCwd();
  const cwdB = await makeCwd();
  const profileA = await approveWorkspaceProfile({ homeDir, cwd: cwdA, name: "A" });
  const profileB = await approveWorkspaceProfile({ homeDir, cwd: cwdB, name: "B" });
  await setDefaultWorkspaceProfile({ homeDir, profileId: profileB.id });
  await revokeWorkspaceProfile({ homeDir, profileId: profileA.id });

  const listing = await listWorkspaceProfiles({ homeDir });
  const projection = toExtensionWorkspaceProfileProjection(listing);

  expect(projection).toEqual([{ id: profileB.id, label: "B", isDefault: true }]);
  for (const entry of projection) {
    expect(Object.keys(entry).sort()).toEqual(["id", "isDefault", "label"]);
  }
});

test("revoking the default profile clears the default", async () => {
  const homeDir = await makeHomeDir();
  const cwd = await makeCwd();
  const profile = await approveWorkspaceProfile({ homeDir, cwd });
  await setDefaultWorkspaceProfile({ homeDir, profileId: profile.id });

  await revokeWorkspaceProfile({ homeDir, profileId: profile.id });

  const { defaultProfileId } = await listWorkspaceProfiles({ homeDir });
  expect(defaultProfileId).toBeNull();
});
