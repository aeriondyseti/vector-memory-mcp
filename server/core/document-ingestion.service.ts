import { readFileSync, readdirSync, statSync } from "fs";
import { basename, extname, join, resolve } from "path";
import type { MemoryService } from "./memory.service";

const DEFAULT_EXTENSIONS = [".md", ".txt", ".json"];
const DEFAULT_MAX_FILES = 100;
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 1;
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".vector-memory"]);

/** Split text into sentences on sentence-ending punctuation followed by whitespace. */
function splitSentences(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0);
  return sentences.length > 0 ? sentences : text.length > 0 ? [text] : [];
}

/** Hard-split a single overlong sentence into chunkSize-sized pieces. */
function hardSplit(sentence: string, chunkSize: number): string[] {
  const pieces: string[] = [];
  for (let i = 0; i < sentence.length; i += chunkSize) {
    pieces.push(sentence.slice(i, i + chunkSize));
  }
  return pieces;
}

/**
 * Chunk text at sentence boundaries: greedily accumulate sentences until
 * adding the next would exceed chunkSize characters, then start a new chunk
 * carrying the last chunkOverlap sentences forward. Sentences longer than
 * chunkSize are hard-split.
 */
export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Expand any oversized sentence into hard-split pieces up front so the
  // greedy accumulation loop below only ever deals with chunkSize-safe units.
  const sentences: string[] = [];
  for (const s of splitSentences(trimmed)) {
    if (s.length > chunkSize) {
      sentences.push(...hardSplit(s, chunkSize));
    } else {
      sentences.push(s);
    }
  }

  const joinedLength = (parts: string[]): number =>
    parts.reduce((acc, s, i) => acc + s.length + (i > 0 ? 1 : 0), 0);

  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join(" "));
    }
  };

  for (const sentence of sentences) {
    const wouldBeLength = joinedLength(current.length > 0 ? [...current, sentence] : [sentence]);
    if (current.length > 0 && wouldBeLength > chunkSize) {
      flush();
      // Carry the last `chunkOverlap` sentences forward into the new chunk.
      current = current.slice(Math.max(0, current.length - chunkOverlap));
    }
    current.push(sentence);
  }
  flush();

  return chunks;
}

/** A run of a document's text under one heading path ([] = before the first heading). */
export interface DocumentSection {
  headings: string[];
  text: string;
}

/**
 * Split Markdown into sections at its ATX headings ("# ", "## ", …), each
 * carrying the path of headings above it; headings inside fenced code blocks
 * don't count. Text before the first heading is a section with no headings.
 */
export function markdownSections(markdown: string): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const path: Array<{ level: number; title: string }> = [];
  let lines: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    const text = lines.join("\n").trim();
    if (text.length > 0) sections.push({ headings: path.map((h) => h.title), text });
    lines = [];
  };

  for (const line of markdown.split(/\r?\n/)) {
    const fenceMark = line.match(/^\s*(```|~~~)/)?.[1];
    if (fenceMark && (fence === null || fence === fenceMark)) fence = fence === null ? fenceMark : null;
    const heading = fence === null && !fenceMark ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/) : null;
    if (!heading) {
      lines.push(line);
      continue;
    }
    flush();
    const level = heading[1]!.length;
    while (path.length > 0 && path[path.length - 1]!.level >= level) path.pop();
    path.push({ level, title: heading[2]! });
  }
  flush();
  return sections;
}

/** A Markdown document's title: frontmatter `title:`, else its first level-1 heading. */
function markdownTitle(markdown: string): string | null {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const fromFrontmatter = frontmatter?.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1];
  return fromFrontmatter ?? markdown.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1] ?? null;
}

/**
 * A document's chunks, each with its context: "Title > Heading > Subheading"
 * for Markdown (chunked section by section, the heading path naming each
 * chunk), "Title" otherwise. The title is the file name without extension
 * unless a Markdown document names its own.
 */
export function documentChunks(
  text: string,
  filePath: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  chunkOverlap: number = DEFAULT_CHUNK_OVERLAP,
): Array<{ text: string; context: string }> {
  const fileTitle = basename(filePath, extname(filePath));
  if (extname(filePath).toLowerCase() !== ".md") {
    return chunkText(text, chunkSize, chunkOverlap).map((t) => ({ text: t, context: fileTitle }));
  }
  const title = markdownTitle(text) ?? fileTitle;
  return markdownSections(text).flatMap((s) => {
    // The title heading is already the context's first step.
    const headings = s.headings[0] === title ? s.headings.slice(1) : s.headings;
    const context = [title, ...headings].join(" > ");
    return chunkText(s.text, chunkSize, chunkOverlap).map((t) => ({ text: t, context }));
  });
}

/** Best-effort pretty-print of JSON text; falls back to the raw text on parse failure. */
function prepareJsonText(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface WalkResult {
  files: string[];
  truncated: boolean;
}

function walkDirectory(
  dir: string,
  extensions: string[],
  maxFiles: number,
): WalkResult {
  const files: string[] = [];
  let truncated = false;

  const visit = (current: string): void => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      if (SKIPPED_DIRS.has(entry)) continue;
      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
      } else if (stat.isFile() && extensions.includes(extname(entry).toLowerCase())) {
        files.push(full);
      }
    }
  };

  visit(dir);
  return { files: files.slice(0, maxFiles), truncated };
}

export interface DocumentIngestionResult {
  filesProcessed: number;
  chunks: number;
  memoryIds: string[];
  errors: string[];
}

export interface DocumentIngestionOptions {
  filePath?: string;
  directoryPath?: string;
  tags?: string[];
  chunkSize?: number;
  chunkOverlap?: number;
  extensions?: string[];
  maxFiles?: number;
  project?: string;
}

/**
 * Document ingestion (Feature 17): chunk Markdown (section by section)/text/JSON files at sentence
 * boundaries and store each chunk as a memory via MemoryService. Dependency-free
 * — no PDF/office-document parsing, plain text files only.
 */
export class DocumentIngestionService {
  constructor(private service: MemoryService) {}

  async ingest(opts: DocumentIngestionOptions): Promise<DocumentIngestionResult> {
    if (!opts.filePath && !opts.directoryPath) {
      throw new Error("ingest requires exactly one of filePath or directoryPath");
    }
    if (opts.filePath && opts.directoryPath) {
      throw new Error("ingest requires exactly one of filePath or directoryPath");
    }

    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const chunkOverlap = opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
    const tags = opts.tags ?? [];

    let filePaths: string[];
    if (opts.filePath) {
      filePaths = [resolve(opts.filePath)];
    } else {
      const extensions = (opts.extensions ?? DEFAULT_EXTENSIONS).map((e) => e.toLowerCase());
      const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
      const { files } = walkDirectory(resolve(opts.directoryPath!), extensions, maxFiles);
      filePaths = files;
    }

    const result: DocumentIngestionResult = {
      filesProcessed: 0,
      chunks: 0,
      memoryIds: [],
      errors: [],
    };

    for (const filePath of filePaths) {
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch (err) {
        result.errors.push(
          `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      const text = extname(filePath).toLowerCase() === ".json" ? prepareJsonText(raw) : raw;
      const chunks = documentChunks(text, filePath, chunkSize, chunkOverlap);
      if (chunks.length === 0) {
        result.filesProcessed += 1;
        continue;
      }

      try {
        for (let i = 0; i < chunks.length; i++) {
          const memory = await this.service.store(
            chunks[i]!.text,
            {
              source: filePath,
              chunk_index: i,
              total_chunks: chunks.length,
              tags,
              type: "document",
            },
            undefined,
            opts.project,
            { context: chunks[i]!.context },
          );
          result.memoryIds.push(memory.id);
          result.chunks += 1;
        }
        result.filesProcessed += 1;
      } catch (err) {
        result.errors.push(
          `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return result;
  }
}
