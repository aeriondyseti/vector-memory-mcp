import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export interface HandoffInput {
  summary: string;
  completed?: string[];
  inProgress?: string[];
  keyDecisions?: string[];
  nextSteps?: string[];
  memoryIds?: string[];
  project?: string | null;
  branch?: string;
}

export interface Handoff extends HandoffInput {
  id: string;
  createdAt: string;
  resumedAt: string | null;
}

/**
 * History-aware session handoff store (Feature 20). Unlike waypoints (one
 * last-writer-wins slot per project), handoffs are appended with a UUID and
 * never overwritten, so a project keeps a resumable history. Stored in a
 * sidecar JSON file next to the database — no schema change.
 */
export class HandoffService {
  constructor(private dbPath: string) {}

  private storePath(): string {
    return join(dirname(this.dbPath), "handoffs.json");
  }

  private read(): Handoff[] {
    try {
      const raw = readFileSync(this.storePath(), "utf-8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as Handoff[]) : [];
    } catch {
      return [];
    }
  }

  private write(handoffs: Handoff[]): void {
    try {
      writeFileSync(this.storePath(), JSON.stringify(handoffs, null, 2));
    } catch {
      // best-effort — never throw on sidecar write failure
    }
  }

  /** Store a new handoff (never overwrites a prior one). */
  prepare(input: HandoffInput): Handoff {
    const handoff: Handoff = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      resumedAt: null,
    };
    const all = this.read();
    all.push(handoff);
    this.write(all);
    return handoff;
  }

  /**
   * Load a handoff (the given id, or the most recent) and mark it resumed.
   * Optionally scope to a project. Returns null when there is nothing to resume.
   */
  resume(id?: string, project?: string | null): Handoff | null {
    const all = this.read();
    const scoped = project
      ? all.filter((h) => h.project === project)
      : all;
    const target = id
      ? scoped.find((h) => h.id === id)
      : scoped[scoped.length - 1];
    if (!target) return null;
    target.resumedAt = new Date().toISOString();
    this.write(all);
    return target;
  }

  /** List handoffs newest-first, optionally scoped to a project. */
  list(limit = 20, project?: string | null): Handoff[] {
    const all = this.read();
    const scoped = project ? all.filter((h) => h.project === project) : all;
    return scoped.slice(-limit).reverse();
  }

  /** The most recent handoff (optionally scoped), without marking it resumed. */
  latest(project?: string | null): Handoff | null {
    const list = this.list(1, project);
    return list[0] ?? null;
  }

  /** Render a handoff as a compact Markdown block for context injection. */
  static render(h: Handoff): string {
    const section = (title: string, items?: string[]): string => {
      if (!items || items.length === 0) return "";
      return `\n## ${title}\n${items.map((i) => `- ${i}`).join("\n")}`;
    };
    return (
      `# Handoff ${h.id}\n` +
      `**Created:** ${h.createdAt}${h.branch ? ` | **Branch:** ${h.branch}` : ""}` +
      `${h.project ? ` | **Project:** ${h.project}` : ""}\n\n` +
      `## Summary\n${h.summary}` +
      section("Completed", h.completed) +
      section("In Progress / Blocked", h.inProgress) +
      section("Key Decisions", h.keyDecisions) +
      section("Next Steps", h.nextSteps) +
      section("Memory IDs", h.memoryIds)
    );
  }
}
