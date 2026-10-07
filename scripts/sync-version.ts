#!/usr/bin/env bun
/**
 * Sync the package version into the plugin manifest and refresh the
 * plugin's hook-kit dependency. Runs as npm's `version` lifecycle hook (pre-
 * releases), so everything it writes is staged into the commit that
 * `npm version` creates; before a stable release, run it on its own to
 * refresh hook-kit, then release with plugin-kit (see CLAUDE.md).
 *
 * Usage:
 *   bun scripts/sync-version.ts              # reads version from package.json
 *   bun scripts/sync-version.ts 3.0.0        # uses explicit version
 *
 * plugin/.mcp.json is not stamped: it always runs `@latest`. The plugin's
 * marketplace entry lives in aeriondyseti-plugins and is pinned by
 * `plugin-kit release`.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const PLUGIN_DIR = join(ROOT, "plugin");
const PLUGIN_PATH = join(PLUGIN_DIR, ".claude-plugin", "plugin.json");

const explicit = process.argv[2];
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const version: string = explicit ?? pkg.version;

// ── Stamp plugin.json ───────────────────────────────────────────────

const plugin = JSON.parse(readFileSync(PLUGIN_PATH, "utf-8"));
plugin.version = version;
writeFileSync(PLUGIN_PATH, JSON.stringify(plugin, null, 2) + "\n");

console.error(`Synced version ${version} → plugin.json`);

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
