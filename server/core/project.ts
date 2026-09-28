import { basename } from "path";

/**
 * Canonical project identifier: the normalized absolute path of the project
 * root (e.g. `/home/user/Development/my-repo`).
 *
 * This exact function must be used everywhere a project value is produced or
 * compared — memory stamping, waypoint ID hashing, search filters, the
 * consolidation re-key, and the hooks' `?project=` param — so values join
 * byte-for-byte across subsystems.
 */
export function normalizeProject(value: string): string {
  let p = value.trim();
  if (p.length === 0) return "";
  // Collapse trailing slashes (but keep bare root "/")
  p = p.replace(/\/+$/, "");
  if (p.length === 0) return "/";
  if (!p.startsWith("/")) p = `/${p}`;
  return p;
}

/** Short human-readable name for a project path. */
export function projectDisplayName(project: string): string {
  return basename(project) || project;
}
