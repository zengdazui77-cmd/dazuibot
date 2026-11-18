import { describe, expect, it } from "vitest";
import { parseReleaseInstaller, RELEASE_PLATFORMS } from "../src/lib/release-assets";

describe("GitHub release installer assets", () => {
  it("recognizes the six supported product/architecture artifacts", () => {
    const names = [
      ["dazuibot-1.0.0-zdzui.1-win-x64.exe", "win-x64"],
      ["dazuibot-1.0.0-zdzui.1-win-arm64.exe", "win-arm64"],
      ["dazuibot-1.0.0-zdzui.1-mac-arm64.dmg", "mac-arm64"],
      ["dazuibot-1.0.0-zdzui.1-mac-x64.dmg", "mac-x64"],
      ["dazuibot-1.0.0-zdzui.1-linux-x64.AppImage", "linux-x64"],
      ["dazuibot-1.0.0-zdzui.1-linux-arm64.AppImage", "linux-arm64"],
    ] as const;
    expect(names.map(([name]) => parseReleaseInstaller(name)?.platform)).toEqual(names.map(([, platform]) => platform));
    expect(new Set(names.map(([, platform]) => platform))).toEqual(new Set(RELEASE_PLATFORMS));
  });

  it("preserves preview versions and supports the legacy linux x86_64 spelling", () => {
    expect(parseReleaseInstaller("dazuibot-2.3.4-rc.2-linux-x86_64.AppImage")).toEqual({ version: "2.3.4-rc.2", platform: "linux-x64" });
    expect(parseReleaseInstaller("dazuibot-2.3.4-rc.2-win-arm64.exe")).toEqual({ version: "2.3.4-rc.2", platform: "win-arm64" });
  });

  it("rejects unrelated files and invalid platform/extension combinations", () => {
    expect(parseReleaseInstaller("other-1.0.0-win-arm64.exe")).toBeUndefined();
    expect(parseReleaseInstaller("dazuibot-1.0.0-win-arm64.dmg")).toBeUndefined();
    expect(parseReleaseInstaller("dazuibot-1.0.0-linux-x64.exe")).toBeUndefined();
  });
});
