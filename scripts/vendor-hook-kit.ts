#!/usr/bin/env bun
/**
 * Vendor @aeriondyseti/hook-kit into the self-contained plugin.
 *
 * The plugin ships as tracked git files (marketplace `source: "./"`), and
 * node_modules is gitignored — so a user who installs the plugin has NO way
 * to resolve an `import from "@aeriondyseti/hook-kit"`. This script bundles
 * hook-kit (and its lone `string-width` dep) into a single self-contained
 * runtime file the hooks import relatively, mirroring how hooks-lib.ts is a
 * self-contained duplicate rather than a cross-package import.
 *
 * Output (committed, ships with the plugin):
 *   plugin/hooks/scripts/vendor/hook-kit.js    ← bundled runtime (no external deps)
 *   plugin/hooks/scripts/vendor/hook-kit.d.ts  ← type companion (renamed index.d.ts)
 *   plugin/hooks/scripts/vendor/<chunk>.d.ts   ← types referenced by hook-kit.d.ts
 *
 * Usage:
 *   bun run scripts/vendor-hook-kit.ts            # bundle the installed version
 *   bun run scripts/vendor-hook-kit.ts --update   # `bun update` to latest 1.x first
 *
 * `--update` respects the `^1.0.0` range in package.json, so it pulls the
 * latest minor/patch and never a breaking major. It is used at release time
 * (via sync-version.ts) so every publish ships the newest compatible hook-kit.
 * The no-flag form is deterministic and offline — the CI freshness guard uses
 * it to prove the committed bundle matches the lockfile-pinned version.
 */

import { readdirSync, copyFileSync, rmSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const PKG = "@aeriondyseti/hook-kit";
const PKG_DIST = join(ROOT, "node_modules", "@aeriondyseti", "hook-kit", "dist");
const VENDOR = join(ROOT, "plugin", "hooks", "scripts", "vendor");

export interface VendorOptions {
  /** Run `bun update` to pull the latest in-range (1.x) release before bundling. */
  update?: boolean;
}

export async function vendorHookKit(opts: VendorOptions = {}): Promise<string[]> {
  if (opts.update) {
    // Non-fatal: if the registry is unreachable (offline, CI without network),
    // fall through and bundle whatever is already installed so the output
    // stays internally consistent rather than failing the release.
    try {
      // --ignore-scripts: only refresh the lockfile/module; don't re-run the
      // repo's postinstall (warmup downloads the ML model — irrelevant here).
      execSync(`bun update ${PKG} --ignore-scripts`, { cwd: ROOT, stdio: "inherit" });
    } catch (e) {
      console.error(`[vendor-hook-kit] update skipped (${(e as Error).message})`);
    }
  }

  if (!existsSync(join(PKG_DIST, "index.js"))) {
    throw new Error(`hook-kit not installed. Run: bun add -d ${PKG}`);
  }

  // Fresh vendor dir each run so removed upstream files don't linger.
  rmSync(VENDOR, { recursive: true, force: true });
  mkdirSync(VENDOR, { recursive: true });

  // 1) Bundle the runtime: inlines the chunk + string-width into one file with
  //    zero remaining external imports. target=bun matches the hook runtime.
  const build = await Bun.build({
    entrypoints: [join(PKG_DIST, "index.js")],
    target: "bun",
    format: "esm",
    outdir: VENDOR,
    naming: "hook-kit.js",
  });
  if (!build.success) {
    throw new Error(`bundle failed: ${build.logs.join("\n")}`);
  }

  // 2) Copy the type declarations. index.d.ts becomes hook-kit.d.ts so
  //    `./vendor/hook-kit` resolves types; the chunk .d.ts it references
  //    (by exact name, e.g. UserPromptSubmit-*.d.ts) rides along unchanged.
  //    Runtime-only .js/.js.map and the separate `testing` entry are skipped.
  for (const f of readdirSync(PKG_DIST)) {
    if (!f.endsWith(".d.ts")) continue;
    if (f.startsWith("testing")) continue;
    const dest = f === "index.d.ts" ? "hook-kit.d.ts" : f;
    copyFileSync(join(PKG_DIST, f), join(VENDOR, dest));
  }

  return readdirSync(VENDOR).sort();
}

if (import.meta.main) {
  const shipped = await vendorHookKit({ update: process.argv.includes("--update") });
  console.log("Vendored hook-kit → plugin/hooks/scripts/vendor/");
  for (const f of shipped) console.log(`  ${f}`);
}
