#!/usr/bin/env bun
/**
 * Sync version into plugin manifest files and stamp the npm dist-tag
 * into .mcp.json based on the current git branch.
 *
 * Usage:
 *   bun scripts/sync-version.ts              # reads version from package.json
 *   bun scripts/sync-version.ts 2.2.3-dev.4  # uses explicit version
 *
 * Branch → dist-tag mapping:
 *   main     → @latest
 *   rc/*     → @rc
 *   dev      → @dev
 *   *        → @dev  (feature branches default to dev)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const PLUGIN_PATH = join(ROOT, ".claude-plugin", "plugin.json");
const MARKETPLACE_PATH = join(ROOT, ".claude-plugin", "marketplace.json");
const MCP_PATH = join(ROOT, "plugin", ".mcp.json");
const PKG_NAME = "@aeriondyseti/vector-memory-mcp";

const explicit = process.argv[2];
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));
const version: string = explicit ?? pkg.version;

// ── Detect branch and resolve dist-tag ──────────────────────────────

function getCurrentBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function resolveDistTag(branch: string): string {
  if (branch === "main") return "latest";
  if (branch.startsWith("rc/")) return "rc";
  return "dev";
}

const branch = getCurrentBranch();
const distTag = resolveDistTag(branch);

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

// ── Stamp .mcp.json — use dist-tag, not pinned version ─────────────

const mcp = JSON.parse(readFileSync(MCP_PATH, "utf-8"));
for (const server of Object.values(mcp.mcpServers) as any[]) {
  server.args = server.args.map((arg: string) =>
    arg.startsWith(`${PKG_NAME}@`) ? `${PKG_NAME}@${distTag}` : arg
  );
}
writeFileSync(MCP_PATH, JSON.stringify(mcp, null, 2) + "\n");

console.error(`Synced version ${version} (${branch} → @${distTag}) → plugin.json, marketplace.json, .mcp.json`);
