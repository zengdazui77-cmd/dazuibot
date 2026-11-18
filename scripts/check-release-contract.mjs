#!/usr/bin/env node
// Keep package.json, the release matrix, download docs, and website parser aligned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => { console.error(`release:check — ${message}`); process.exit(1); };

const pkg = JSON.parse(read("package.json"));
const release = read(".github/workflows/release.yml");
const artifactName = `"artifactName": "${pkg.productName}-\${version}-\${os}-\${arch}.\${ext}"`;
if (!read("package.json").includes(artifactName)) fail(`package.json artifactName must start with ${pkg.productName}-`);

const matrixBlock = /^\s*all='(\[[\s\S]*?\])'\s*$/m.exec(release)?.[1];
if (!matrixBlock) fail("could not locate the release workflow installer matrix");
let matrix;
try { matrix = JSON.parse(matrixBlock); } catch (error) { fail(`release matrix is not valid JSON: ${error.message}`); }

const platformName = { darwin: "mac", win32: "win", linux: "linux" };
const extension = { darwin: "dmg", win32: "exe", linux: "AppImage" };
const requiredTargets = ["mac-arm64", "mac-x64", "win-x64", "win-arm64", "linux-x64", "linux-arm64"];
const expectedTargets = new Set(requiredTargets);
for (const item of matrix) {
  const platform = platformName[item.os];
  if (!platform || !["x64", "arm64"].includes(item.arch)) fail(`unsupported release target: ${item.name}`);
  const target = `${platform}-${item.arch}`;
  if (item.name !== target || item.file !== `${target}.${extension[item.os]}`) fail(`${item.name} file must be ${target}.${extension[item.os]}`);
  expectedTargets.delete(item.name);

  const appDirectory = item.os === "win32"
    ? (item.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked")
    : item.os === "darwin"
      ? (item.arch === "arm64" ? "mac-arm64" : "mac")
      : (item.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked");
  const appExecutable = item.os === "darwin"
    ? `${pkg.productName}.app/Contents/MacOS/${pkg.productName}`
    : `${pkg.productName}${item.os === "win32" ? ".exe" : ""}`;
  if (item.app !== `release/${appDirectory}/${appExecutable}`) fail(`${item.name} app path does not match product ${pkg.productName}`);
}
if (expectedTargets.size || matrix.length !== 6) fail(`release matrix is incomplete: ${[...expectedTargets].join(", ")}`);

const installerTemplate = `INSTALLER: release/${pkg.productName}-\${{ needs.meta.outputs.version }}-\${{ matrix.file }}`;
if (!release.includes(installerTemplate)) fail("workflow installer path does not use package productName/version and matrix filename");
if (!release.includes(`pattern: ${pkg.productName}-\${{ needs.meta.outputs.version }}-*`)) fail("release job artifact download pattern is stale");
if (!release.includes("WIN_CSC_LINK") || !release.includes("WIN_CSC_KEY_PASSWORD") || !release.includes("Get-AuthenticodeSignature")) {
  fail("tagged Windows release must require signing secrets and verify the Authenticode signature");
}

for (const file of ["README.md", "README_en.md"]) {
  const docs = read(file);
  for (const target of matrix) {
    const platform = platformName[target.os];
    const versioned = `\`${pkg.productName}-<version>-${platform}-${target.arch}.${extension[target.os]}\``;
    if (!docs.includes(versioned)) fail(`${file} is missing installer name ${versioned}`);
  }
}
const siteAssets = read("site/src/lib/release-assets.ts");
const siteLib = read("site/src/lib/site.ts");
const downloadView = read("site/src/views/DownloadView.astro");
for (const target of requiredTargets) {
  if (!siteAssets.includes(`"${target}"`)) fail(`website release parser is missing ${target}`);
  if (!siteLib.includes(`"${target}": Bin`)) fail(`website release schema is missing ${target}`);
  if (!read("site/src/data/releases.json").includes(`"${target}"`)) fail(`website release data is missing ${target}`);
}
for (const target of ["win-arm64", "linux-arm64"]) if (!downloadView.includes(`"${target}"`)) fail(`download page is missing the ${target} selector`);
if (!read("site/scripts/releases-from-github.ts").includes("parseReleaseInstaller") || !read("site/scripts/releases-from-dir.ts").includes("parseReleaseInstaller")) {
  fail("website release generators must use the shared installer asset parser");
}

console.log(`release:check — ${matrix.length} installer targets, download names, and Windows signing gate are aligned`);
