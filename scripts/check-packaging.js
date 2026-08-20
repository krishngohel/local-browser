"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const required = [
  "build/icon.png",
  "build/entitlements.mac.plist",
  "legal/PRIVACY.md",
  "legal/TERMS.md",
  "LICENSE",
  "skills/ECHO-SKILL-TREE.md",
  "package.json",
  "scripts/echo-mcp-bridge.cjs",
];

let failed = false;
for (const rel of required) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.error(`Missing packaging file: ${rel}`);
    failed = true;
    continue;
  }
  if (fs.statSync(file).size < 8) {
    console.error(`Packaging file is empty: ${rel}`);
    failed = true;
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mac = pkg.build && pkg.build.mac;
if (!mac) {
  console.error("package.json is missing build.mac");
  failed = true;
} else {
  if (mac.identity !== null) {
    console.error("build.mac.identity must be null until an Apple Developer cert is configured");
    failed = true;
  }
  if (mac.hardenedRuntime) {
    console.error("build.mac.hardenedRuntime must be false while the Mac build is unsigned");
    failed = true;
  }
  const info = mac.extendInfo || {};
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSLocalNetworkUsageDescription"]) {
    if (!info[key]) {
      console.error(`build.mac.extendInfo is missing ${key}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("Packaging assets look complete for Windows / Mac / Linux installers.");
