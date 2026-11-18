export const RELEASE_PLATFORMS = [
  "win-x64",
  "win-arm64",
  "mac-arm64",
  "mac-x64",
  "linux-x64",
  "linux-arm64",
] as const;

export type ReleasePlatform = typeof RELEASE_PLATFORMS[number];

const ASSET_PLATFORM: Record<string, ReleasePlatform> = {
  "win-x64-exe": "win-x64",
  "win-arm64-exe": "win-arm64",
  "mac-arm64-dmg": "mac-arm64",
  "mac-x64-dmg": "mac-x64",
  "linux-arm64-AppImage": "linux-arm64",
  "linux-x64-AppImage": "linux-x64",
  // Accept archives that used Go's x86_64 name before electron-builder naming was normalized.
  "linux-x86_64-AppImage": "linux-x64",
};

const INSTALLER = /^dazuibot-(\d+\.\d+\.\d+(?:-[\w.]+)?)-(win|mac|linux)-(x64|arm64|x86_64)\.(exe|dmg|AppImage)$/;

export function parseReleaseInstaller(name: string): { version: string; platform: ReleasePlatform } | undefined {
  const match = INSTALLER.exec(name);
  if (!match) return undefined;
  const platform = ASSET_PLATFORM[`${match[2]}-${match[3]}-${match[4]}`];
  return platform ? { version: match[1], platform } : undefined;
}
