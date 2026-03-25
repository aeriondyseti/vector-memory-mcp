#!/usr/bin/env bun
/**
 * Sync version into .claude-plugin/ manifest files.
 *
 * Usage:
 *   bun scripts/sync-version.ts           # reads version from package.json
 *   bun scripts/sync-version.ts 2.2.3-dev.4  # uses explicit version
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const PLUGIN_PATH = join(ROOT, ".claude-plugin", "plugin.json");
const MARKETPLACE_PATH = join(ROOT, ".claude-plugin", "marketplace.json");

const explicit = process.argv[2];
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const version: string = explicit ?? pkg.version;

// Stamp plugin.json
const plugin = JSON.parse(readFileSync(PLUGIN_PATH, "utf-8"));
plugin.version = version;
writeFileSync(PLUGIN_PATH, JSON.stringify(plugin, null, 2) + "\n");

// Stamp marketplace.json
const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, "utf-8"));
marketplace.metadata.version = version;
for (const p of marketplace.plugins) {
  p.version = version;
}
writeFileSync(MARKETPLACE_PATH, JSON.stringify(marketplace, null, 2) + "\n");

console.error(`Synced version ${version} → plugin.json, marketplace.json`);
