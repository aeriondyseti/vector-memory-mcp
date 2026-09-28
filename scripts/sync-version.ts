#!/usr/bin/env bun
/**
 * Sync the package version into the plugin manifests and refresh the
 * plugin's hook-kit dependency. Runs as npm's `version` lifecycle hook, so
 * everything it writes is staged into the release commit that `npm version`
 * creates.
 *
 * Usage:
 *   bun scripts/sync-version.ts              # reads version from package.json
 *   bun scripts/sync-version.ts 3.0.0        # uses explicit version
 *
 * plugin/.mcp.json is not stamped: it always runs `@latest`.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const PLUGIN_DIR = join(ROOT, "plugin");
const PLUGIN_PATH = join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
const MARKETPLACE_PATH = join(ROOT, ".claude-plugin", "marketplace.json");

const explicit = process.argv[2];
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const version: string = explicit ?? pkg.version;

// ── Stamp plugin.json ───────────────────────────────────────────────

const plugin = JSON.parse(readFileSync(PLUGIN_PATH, "utf-8"));
plugin.version = version;
writeFileSync(PLUGIN_PATH, JSON.stringify(plugin, null, 2) + "\n");

// ── Stamp marketplace.json ──────────────────────────────────────────

const marketplace = JSON.parse(readFileSync(MARKETPLACE_PATH, "utf-8"));
marketplace.metadata.version = version;
for (const p of marketplace.plugins) {
  p.version = version;
}
writeFileSync(MARKETPLACE_PATH, JSON.stringify(marketplace, null, 2) + "\n");

console.error(`Synced version ${version} → plugin.json, marketplace.json`);

// ── Refresh hook-kit to the latest in-range (1.x) release ───────────
//
// Updates plugin/bun.lock, which Claude Code installs from when it copies
// the plugin. Runs only for local release prep: in CI the committed
// lockfile is authoritative (a tag is immutable).
const inCI = process.env.CI === "true" || !!process.env.GITHUB_ACTIONS;
if (!inCI) {
  try {
    execSync("bun update @aeriondyseti/hook-kit", { cwd: PLUGIN_DIR, stdio: "inherit" });
  } catch (e) {
    console.error(`[sync-version] hook-kit refresh skipped: ${(e as Error).message}`);
  }
}
