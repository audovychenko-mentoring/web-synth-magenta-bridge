import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const sdkDir = join(repoRoot, "vendor/ableton-sdk");
const liveBetaPath = "/Applications/Ableton Live 12 Suite Beta.app";
const requiredNode = [24, 16, 0];

function parseVersion(version) {
  return version.replace(/^v/, "").split(".").map((part) => Number(part));
}

function versionAtLeast(actual, required) {
  for (let index = 0; index < required.length; index += 1) {
    if ((actual[index] || 0) > required[index]) return true;
    if ((actual[index] || 0) < required[index]) return false;
  }
  return true;
}

function sdkFiles() {
  if (!existsSync(sdkDir)) return [];
  return readdirSync(sdkDir).filter((file) => file.endsWith(".tgz"));
}

const nodeVersion = parseVersion(process.version);
const hasNode = versionAtLeast(nodeVersion, requiredNode);
const hasLiveBeta = existsSync(liveBetaPath);
const tarballs = sdkFiles();
const hasCreateExtension = tarballs.some((file) => file.includes("create-extension"));
const hasSdk = tarballs.some((file) => file.includes("sdk"));
const ok = hasNode && hasLiveBeta && hasCreateExtension && hasSdk;

const rows = [
  ["Node >= 24.16.0", hasNode ? `ok (${process.version})` : `missing (${process.version})`],
  ["Live 12 Suite Beta app", hasLiveBeta ? "ok" : `missing (${liveBetaPath})`],
  ["Ableton SDK tarballs", tarballs.length ? `found ${tarballs.join(", ")}` : `missing (${sdkDir})`],
  ["create-extension tarball", hasCreateExtension ? "ok" : "missing"],
  ["sdk tarball", hasSdk ? "ok" : "missing"]
];

console.log("Ableton Extension prerequisites");
for (const [label, status] of rows) {
  console.log(`- ${label}: ${status}`);
}

if (!ok) {
  console.log("");
  console.log("Next setup steps:");
  console.log("1. Join Ableton's beta program and install Live 12.4.5 Suite Beta or later.");
  console.log("2. Download the Extensions SDK and Documentation from Ableton Centercode.");
  console.log("3. Put the SDK .tgz files in vendor/ableton-sdk/.");
  console.log("4. Re-run npm run ableton:check.");
}

if (process.argv.includes("--dev") || process.argv.includes("--package")) {
  process.exit(ok ? 0 : 1);
}
