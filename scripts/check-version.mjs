#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const tauriConf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");

const tauriVersion = tauriConf.version;
const cargoVersionMatch = cargoToml.match(/version\s*=\s*"([^"]+)"/);
const cargoVersion = cargoVersionMatch ? cargoVersionMatch[1] : null;

if (!cargoVersion) {
  console.error("Cannot find version in Cargo.toml");
  process.exit(1);
}

if (tauriVersion !== cargoVersion) {
  console.error(`Version mismatch: tauri.conf.json=${tauriVersion}, Cargo.toml=${cargoVersion}`);
  process.exit(1);
}

console.log(`Version check passed: v${tauriVersion}`);
