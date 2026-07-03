import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const CHROME_NATIVE_HOST_NAME = "com.forgelet.browser_context";

export interface InstalledChromeNativeHost {
  manifestPath: string;
  hostPath: string;
  extensionId: string;
}

export async function installChromeNativeMessagingHost(input: {
  extensionId: string;
  homeDir: string;
  workspaceRoot: string;
  nodePath?: string;
}): Promise<InstalledChromeNativeHost> {
  validateChromeExtensionId(input.extensionId);
  const hostPath = join(
    input.homeDir,
    ".forgelet",
    "browser",
    "native-host",
    "forgelet-browser-host",
  );
  const hostEntryPath = resolve(
    input.workspaceRoot,
    "dist",
    "native-host",
    "index.js",
  );
  await mkdir(dirname(hostPath), { recursive: true });
  await writeFile(
    hostPath,
    [
      "#!/bin/sh",
      `exec ${JSON.stringify(input.nodePath ?? process.execPath)} ${JSON.stringify(hostEntryPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(hostPath, 0o755);

  const manifestPath = chromeNativeMessagingManifestPath(input.homeDir);
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: CHROME_NATIVE_HOST_NAME,
        description: "Forgelet browser context snapshot producer",
        path: hostPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${input.extensionId}/`],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { manifestPath, hostPath, extensionId: input.extensionId };
}

export function chromeNativeMessagingManifestPath(homeDir: string): string {
  return join(
    homeDir,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${CHROME_NATIVE_HOST_NAME}.json`,
  );
}

function validateChromeExtensionId(extensionId: string): void {
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new Error(
      "Chrome extension id must be 32 lowercase letters from a to p.",
    );
  }
}
