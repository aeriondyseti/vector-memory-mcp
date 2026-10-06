/**
 * Obsidian vault → benchmark dataset.
 *
 * Builds a large dataset from a local Obsidian vault, read at run time:
 * nothing from the vault is written into the repository (a parsed copy
 * may be cached under the gitignored .vector-memory/).
 *
 * - Memories: one per note section (split at ~maxChunkChars), without the
 *   note title, as document ingestion would store them. Frontmatter,
 *   statblock/callout blocks, lorem ipsum and template boilerplate
 *   (paragraphs repeated in boilerplateMinNotes+ notes) are dropped.
 * - Graph: one entity per note; a memory links to an entity when its text
 *   carries a [[wikilink]] to that note; frontmatter link fields become
 *   entity↔entity relations. Membership (chunk → its own note) is NOT a
 *   link unless `membershipLinks` is set, since title queries are judged
 *   by membership — with it, the graph answers them by construction.
 * - Queries, sampled with a fixed seed (category in brackets):
 *     section lookup     "Title: Heading"              → that section  [exact_match]
 *     summary paraphrase first sentence of the note's frontmatter summary
 *                        (not stored as a memory)      → the note       [semantic]
 *     title lookup       "What do we know about Title?" → the note      [related_concept]
 *     negative           off-domain questions                          [negative]
 *   A note's first 5 chunks are relevant, the rest partially relevant.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { basename, join, relative, sep } from "path";
import { chunkText } from "../../../server/core/document-ingestion.service";
import { Sampler } from "../loaders/sampler";
import type { BenchmarkDataset, BenchmarkGraph, GroundTruthMemory, GroundTruthQuery } from "../types";
import { generalDataset } from "./general";

export interface ObsidianOptions {
  vaultPath: string;
  /** Queries per generated category (default 100). */
  queriesPerCategory?: number;
  seed?: number;
  /** Top-level folders (or any path segment) to skip. */
  excludeFolders?: string[];
  /** Split sections longer than this (default 1000 chars). */
  maxChunkChars?: number;
  /** A paragraph in this many notes or more is template boilerplate (default 3). */
  boilerplateMinNotes?: number;
  /** Link each chunk to its own note's entity (an upper bound, see above). */
  membershipLinks?: boolean;
  /**
   * Hand-written questions (JSON array of BespokeQuestion), kept outside the
   * repository since they quote the vault. Added as the "bespoke" category.
   */
  bespokeFile?: string;
}

/** A hand-written question; answers name note sections by heading. */
export interface BespokeQuestion {
  id: string;
  query: string;
  /** factual, entity, event, temporal, relational, open_thread, synthesis, decision */
  kind: string;
  /** Sections that answer it: heading null = any section of the note; "(intro)" = before the first heading */
  answers: Array<{ note: string; heading: string | null }>;
  /** Sections that help but don't answer on their own */
  supporting?: Array<{ note: string; heading: string | null }>;
  rationale?: string;
}

export interface VaultStats {
  notesScanned: number;
  notesWithChunks: number;
  chunks: number;
  boilerplateParagraphsDropped: number;
  entities: number;
  memoryLinks: number;
  relations: number;
  unresolvedLinks: number;
  /** Bespoke questions in the file, kept, and dropped (with why) */
  bespoke?: { inFile: number; kept: number; dropped: Array<{ id: string; reason: string }> };
}

/** Folders and files skipped by name: tooling, attachments, legacy copies, navigation. */
const DEFAULT_EXCLUDES = [
  ".obsidian",
  ".trash",
  "_attachments",
  "00 Home",
  "90 Legacy",
  "95 Archive",
  "99 Migration",
  "_Index.md",
];
const RELEVANT_PER_NOTE = 5;
const MIN_SECTION_CHARS = 60;

interface Note {
  id: string; // vault-relative path without .md, "/"-separated
  title: string;
  type: string | null;
  summary: string | null;
  frontmatter: Map<string, string[]>; // key → raw values (scalars and list items)
  body: string;
}

interface Section {
  heading: string | null;
  raw: string; // markdown with wikilinks
}

// ── Parsing ─────────────────────────────────────────────────────────

function walk(dir: string, root: string, excludes: Set<string>, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (excludes.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, root, excludes, out);
    else if (name.endsWith(".md")) out.push(full);
  }
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** Minimal YAML frontmatter: `key: value` scalars and `  - item` lists. */
function parseNote(path: string, root: string): Note {
  const text = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
  const frontmatter = new Map<string, string[]>();
  let body = text;
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = text.slice(fm[0].length);
    let key: string | null = null;
    for (const line of fm[1].split("\n")) {
      const item = line.match(/^\s+-\s+(.*)$/);
      const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (item && key) frontmatter.get(key)!.push(unquote(item[1]));
      else if (pair) {
        key = pair[1];
        frontmatter.set(key, pair[2].trim() === "" ? [] : [unquote(pair[2])]);
      }
    }
  }
  const id = relative(root, path).split(sep).join("/").replace(/\.md$/, "");
  const first = (k: string) => frontmatter.get(k)?.[0] ?? null;
  return {
    id,
    title: first("title") || basename(id),
    type: first("type"),
    summary: first("summary") || first("ai_summary"),
    frontmatter,
    body,
  };
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

/** A callout holding a creature statblock (ability-score table, AC/HP line). */
const isStatblock = (lines: string[]) =>
  lines.some((l) => /\|\s*STR\s*\|/.test(l)) || lines.some((l) => /\bAC\s+\d+/.test(l) && /\bHP\s+\d+/.test(l));

/**
 * Split at headings (often tab-indented in Notion exports). Callouts keep
 * their content, their marker line becoming its title; statblock callouts
 * and Statblock sections are dropped.
 */
function sections(body: string): Section[] {
  const out: Section[] = [];
  let current: Section = { heading: null, raw: "" };
  let callout: string[] | null = null;
  const flushCallout = () => {
    if (callout && !isStatblock(callout)) current.raw += `${callout.join("\n")}\n`;
    callout = null;
  };
  for (const line of body.split("\n")) {
    const marker = line.match(/^\s*>\s*\[![^\]]*\][+-]?\s*(.*)$/);
    if (marker) {
      flushCallout();
      callout = [marker[1] ? `${marker[1]}:` : ""];
      continue;
    }
    if (callout && /^\s*>/.test(line)) {
      callout.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }
    flushCallout();
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) {
      out.push(current);
      current = { heading: h[1].replace(/\{[^}]*\}\s*$/, "").trim(), raw: "" };
      continue;
    }
    current.raw += `${line.replace(/^\s*>\s?/, "").replace(/^\s+/, "")}\n`;
  }
  flushCallout();
  out.push(current);
  return out.filter((s) => !/statblock/i.test(s.heading ?? ""));
}

const normalize = (p: string) => p.toLowerCase().replace(/\s+/g, " ").trim();
const paragraphs = (raw: string) => raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

/** Markdown with wikilinks → the text a memory would hold. */
function plain(raw: string): string {
  return raw
    .replace(WIKILINK, (_m, target: string, alias?: string) => alias ?? basename(target.trim()))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // embedded images (often long signed URLs)
    .replace(/!\[\[[^\]]*\]\]/g, "") // embedded files
    .replace(/\[([^\]]+)\]\((?:https?:|file:)[^)]*\)/g, "$1") // external links → their text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, "- ")
    .replace(/\\([[\]])/g, "$1")
    .replace(/\{toggle="true"\}/g, "")
    .replace(/\*\*|__|\*|`/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Building ────────────────────────────────────────────────────────

export function loadObsidianDataset(options: ObsidianOptions): { dataset: BenchmarkDataset; stats: VaultStats } {
  const {
    vaultPath,
    queriesPerCategory = 100,
    seed = 42,
    excludeFolders = DEFAULT_EXCLUDES,
    maxChunkChars = 1000,
    boilerplateMinNotes = 3,
    membershipLinks = false,
  } = options;

  const files: string[] = [];
  walk(vaultPath, vaultPath, new Set(excludeFolders), files);
  const notes = files.map((f) => parseNote(f, vaultPath));

  // Resolve [[targets]] by vault path, then by unique file name.
  const byPath = new Map(notes.map((n) => [n.id.toLowerCase(), n]));
  const byName = new Map<string, Note | null>();
  for (const n of notes) {
    const key = basename(n.id).toLowerCase();
    byName.set(key, byName.has(key) ? null : n);
  }
  let unresolvedLinks = 0;
  const resolve = (target: string): Note | null => {
    const t = target.trim().replace(/\.md$/, "").toLowerCase();
    const hit = byPath.get(t) ?? byName.get(basename(t)) ?? null;
    if (!hit) unresolvedLinks++;
    return hit;
  };

  // Template boilerplate: paragraphs that recur across notes.
  const paragraphNotes = new Map<string, Set<string>>();
  for (const n of notes) {
    for (const s of sections(n.body)) {
      for (const p of paragraphs(s.raw)) {
        const key = normalize(p);
        if (!paragraphNotes.has(key)) paragraphNotes.set(key, new Set());
        paragraphNotes.get(key)!.add(n.id);
      }
    }
  }
  const isBoilerplate = (p: string) =>
    (paragraphNotes.get(normalize(p))?.size ?? 0) >= boilerplateMinNotes || /lorem ipsum/i.test(p);
  const droppedBoilerplate = new Set<string>();

  const memories: GroundTruthMemory[] = [];
  const memoryLinks: NonNullable<BenchmarkGraph["memoryLinks"]> = [];
  const chunksByNote = new Map<string, string[]>();
  const chunksBySection = new Map<string, { note: Note; heading: string; ids: string[] }>();

  for (const n of notes) {
    let i = 0;
    for (const [si, s] of sections(n.body).entries()) {
      const kept = paragraphs(s.raw).filter((p) => {
        if (!isBoilerplate(p)) return true;
        droppedBoilerplate.add(normalize(p));
        return false;
      });
      const raw = kept.join("\n\n");
      if (plain(raw).length < MIN_SECTION_CHARS) continue;

      const sectionKey = `${n.id}#s${si}`;
      for (const piece of raw.length > maxChunkChars ? chunkText(raw, maxChunkChars, 1) : [raw]) {
        const text = plain(piece);
        if (text.length < MIN_SECTION_CHARS) continue;
        const id = `${n.id}#${i++}`;
        memories.push({
          id,
          content: s.heading ? `${plain(s.heading)}: ${text}` : text,
          metadata: { note: n.id, heading: s.heading, type: n.type },
          domain: n.type ?? "note",
        });
        if (!chunksByNote.has(n.id)) chunksByNote.set(n.id, []);
        chunksByNote.get(n.id)!.push(id);
        if (s.heading) {
          if (!chunksBySection.has(sectionKey)) chunksBySection.set(sectionKey, { note: n, heading: plain(s.heading), ids: [] });
          chunksBySection.get(sectionKey)!.ids.push(id);
        }

        const linked = new Set<string>();
        for (const m of piece.matchAll(WIKILINK)) {
          const target = resolve(m[1]);
          if (target && target.id !== n.id) linked.add(target.id);
        }
        if (membershipLinks) linked.add(n.id);
        for (const entityId of linked) memoryLinks.push({ memoryId: id, entityId });
      }
    }
  }

  // Entities: every note; relations from frontmatter link fields.
  const relations: BenchmarkGraph["relations"] = [];
  for (const n of notes) {
    for (const [key, values] of n.frontmatter) {
      for (const v of values) {
        for (const m of v.matchAll(WIKILINK)) {
          const target = resolve(m[1]);
          if (target && target.id !== n.id) relations.push({ from: n.id, to: target.id, type: key });
        }
      }
    }
  }
  const graph: BenchmarkGraph = {
    entities: notes.map((n) => ({ id: n.id, name: n.title, type: n.type ?? "note" })),
    relations,
    memoryLinks,
  };

  // Queries.
  const sampler = new Sampler(seed);
  const pick = <T>(items: T[]): T[] => sampler.shuffleInPlace([...items]).slice(0, queriesPerCategory);
  const relevance = (noteId: string) => {
    const ids = chunksByNote.get(noteId) ?? [];
    return { relevantMemoryIds: ids.slice(0, RELEVANT_PER_NOTE), partiallyRelevantIds: ids.slice(RELEVANT_PER_NOTE) };
  };
  const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim().slice(0, 240);

  const queries: GroundTruthQuery[] = [
    ...pick([...chunksBySection.values()]).map((s, i) => ({
      id: `vault-section-${i}`,
      query: `${s.note.title}: ${s.heading}`,
      relevantMemoryIds: s.ids,
      category: "exact_match" as const,
    })),
    ...pick(notes.filter((n) => n.summary && chunksByNote.has(n.id))).map((n, i) => ({
      id: `vault-summary-${i}`,
      query: firstSentence(n.summary!),
      ...relevance(n.id),
      category: "semantic" as const,
    })),
    ...pick(notes.filter((n) => (chunksByNote.get(n.id)?.length ?? 0) >= 2)).map((n, i) => ({
      id: `vault-title-${i}`,
      query: `What do we know about ${n.title}?`,
      ...relevance(n.id),
      category: "related_concept" as const,
    })),
    ...generalDataset.queries.filter((q) => q.category === "negative"),
  ];

  const bespoke = options.bespokeFile ? loadBespoke(options.bespokeFile, memories) : undefined;
  if (bespoke) queries.push(...bespoke.queries);

  return {
    dataset: {
      name: `obsidian${membershipLinks ? "+membership" : ""}`,
      description: "Local Obsidian vault: sections as memories, wikilinks as the graph",
      memories,
      queries,
      graph,
    },
    stats: {
      notesScanned: notes.length,
      notesWithChunks: chunksByNote.size,
      chunks: memories.length,
      boilerplateParagraphsDropped: droppedBoilerplate.size,
      entities: graph.entities.length,
      memoryLinks: memoryLinks.length,
      relations: relations.length,
      unresolvedLinks,
      ...(bespoke ? { bespoke: bespoke.stats } : {}),
    },
  };
}

const headingKey = (h: string | null) =>
  h === null ? null : plain(h.replace(/^#+\s*/, "").replace(/\{[^}]*\}\s*$/, "")).toLowerCase().replace(/\s+/g, " ");

/**
 * Resolve hand-written questions to memory ids. A question whose answers
 * don't all resolve (note excluded, section dropped as boilerplate or too
 * short, heading mistyped) is dropped and reported rather than half-judged.
 */
function loadBespoke(
  file: string,
  memories: GroundTruthMemory[],
): { queries: GroundTruthQuery[]; stats: NonNullable<VaultStats["bespoke"]> } {
  const questions = JSON.parse(readFileSync(file, "utf-8")) as BespokeQuestion[];
  const chunks = new Map<string, Array<{ id: string; heading: string | null }>>();
  for (const m of memories) {
    const note = String(m.metadata?.note);
    if (!chunks.has(note)) chunks.set(note, []);
    chunks.get(note)!.push({ id: m.id, heading: headingKey((m.metadata?.heading as string | null) ?? null) });
  }
  const resolveRef = (ref: { note: string; heading: string | null }): string[] | string => {
    const inNote = chunks.get(ref.note.replace(/\.md$/, ""));
    if (!inNote) return `no memories for note "${ref.note}"`;
    if (ref.heading === null) return inNote.map((c) => c.id);
    const want = ref.heading.trim().toLowerCase() === "(intro)" ? null : headingKey(ref.heading);
    const ids = inNote.filter((c) => c.heading === want).map((c) => c.id);
    return ids.length > 0 ? ids : `no memory for section "${ref.heading}" of "${ref.note}"`;
  };

  const queries: GroundTruthQuery[] = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  for (const q of questions) {
    const answers = q.answers.map(resolveRef);
    const failure = answers.find((a): a is string => typeof a === "string");
    if (failure) {
      dropped.push({ id: q.id, reason: failure });
      continue;
    }
    const relevant = [...new Set((answers as string[][]).flat())];
    const supporting = (q.supporting ?? [])
      .map(resolveRef)
      .filter((a): a is string[] => Array.isArray(a))
      .flat()
      .filter((id) => !relevant.includes(id));
    queries.push({
      id: `bespoke-${q.id}`,
      query: q.query,
      relevantMemoryIds: relevant,
      partiallyRelevantIds: [...new Set(supporting)],
      category: "bespoke",
      kind: q.kind,
    });
  }
  return { queries, stats: { inFile: questions.length, kept: queries.length, dropped } };
}
