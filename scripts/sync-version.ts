#!/usr/bin/env bun
/**
 * Sync the package version into the plugin manifests and refresh the
 * vendored hook-kit. Runs as npm's `version` lifecycle hook, so everything
 * it writes is staged into the release commit that `npm version` creates.
 *
 * Usage:
 *   bun scripts/sync-version.ts              # reads version from package.json
 *   bun scripts/sync-version.ts 3.0.0        # uses explicit version
 *
 * plugin/.mcp.json is not stamped: it always runs `@latest`.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { vendorHookKit } from "./vendor-hook-kit";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const PLUGIN_PATH = join(ROOT, ".claude-plugin", "plugin.json");
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

// ── Refresh vendored hook-kit to the latest in-range (1.x) release ───
//
// Runs only for local release prep. In CI the committed bundle + lockfile
// are authoritative (a tag is immutable) and the freshness guard verifies
// them — auto-updating there would drift the tree out from under the tag.
const inCI = process.env.CI === "true" || !!process.env.GITHUB_ACTIONS;
if (!inCI) {
  try {
    const shipped = await vendorHookKit({ update: true });
    console.error(`Refreshed vendored hook-kit → ${shipped.join(", ")}`);
  } catch (e) {
    console.error(`[sync-version] hook-kit refresh skipped: ${(e as Error).message}`);
  }
}
