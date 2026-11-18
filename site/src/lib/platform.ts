// 系统识别（§12.2）：userAgentData.platform → 回退 userAgent；macOS 再尽量判断架构，判断不了时默认 Apple 芯片。
export type OS = "win" | "mac" | "linux" | "mobile" | "unknown";
export type Architecture = "arm64" | "x64" | "unknown";
export interface Platform { os: OS; arch: Architecture }

type UAData = { platform?: string; mobile?: boolean; getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string; bitness?: string }> };

export type DownloadPlatformId = "win-x64" | "win-arm64" | "mac-arm64" | "mac-x64" | "linux-x64" | "linux-arm64";

export function architectureFromUAData(architecture?: string, bitness?: string): Architecture {
  const arch = architecture?.toLowerCase();
  if (arch === "arm64" || (arch === "arm" && bitness === "64")) return "arm64";
  if (arch === "x86_64" || (arch === "x86" && bitness === "64")) return "x64";
  return "unknown";
}

/** Unknown Windows/Linux architecture defaults to x64; ARM users can still select the labeled build. */
export function downloadPlatformId(platform: Platform): DownloadPlatformId | null {
  if (platform.os === "win") return platform.arch === "arm64" ? "win-arm64" : "win-x64";
  if (platform.os === "mac") return platform.arch === "x64" ? "mac-x64" : "mac-arm64";
  if (platform.os === "linux") return platform.arch === "arm64" ? "linux-arm64" : "linux-x64";
  return null;
}

export function osFromStrings(platform: string, ua: string, touchMac = false): OS {
  const s = `${platform} ${ua}`;
  if (/android|iphone|ipad|ipod/i.test(s) || touchMac) return "mobile";
  if (/win/i.test(platform) || /windows/i.test(ua)) return "win";
  if (/mac/i.test(platform) || /macintosh|mac os x/i.test(ua)) return "mac";
  if (/linux|x11|cros/i.test(s)) return "linux";
  return "unknown";
}

export async function detectPlatform(): Promise<Platform> {
  const uad = (navigator as Navigator & { userAgentData?: UAData }).userAgentData;
  const ua = navigator.userAgent;
  // iPadOS 13+ 报自己是 Macintosh，用触点数区分
  const touchMac = /macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  const os = uad?.mobile ? "mobile" : osFromStrings(uad?.platform ?? "", ua, touchMac);
  let arch: Platform["arch"] = "unknown";
  if (uad?.getHighEntropyValues && os !== "mobile" && os !== "unknown") {
    try {
      const v = await uad.getHighEntropyValues(["architecture", "bitness"]);
      arch = architectureFromUAData(v.architecture, v.bitness);
    } catch { /* 浏览器不给就按默认 */ }
  }
  return { os, arch };
}
