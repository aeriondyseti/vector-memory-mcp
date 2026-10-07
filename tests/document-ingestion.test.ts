import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection";
import { MemoryRepository } from "../server/core/memory.repository";
import { MemoryService } from "../server/core/memory.service";
import {
  DocumentIngestionService,
  documentChunks,
  markdownSections,
} from "../server/core/document-ingestion.service";
import { createMockEmbeddings, removeDir } from "./utils/test-helpers";

describe("DocumentIngestionService", () => {
  let db: Database;
  let repository: MemoryRepository;
  let service: MemoryService;
  let ingestion: DocumentIngestionService;
  let tmpDir: string;
  let docsDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-ingest-"));
    docsDir = join(tmpDir, "docs");
    mkdirSync(docsDir, { recursive: true });

    const dbPath = join(tmpDir, "test.db");
    db = connectToDatabase(dbPath);
    repository = new MemoryRepository(db);
    service = new MemoryService(repository, createMockEmbeddings());
    ingestion = new DocumentIngestionService(service);
  });

  afterEach(() => {
    db.close();
    removeDir(tmpDir);
  });

  test("ingests a single file and stores at least one chunk", async () => {
    const filePath = join(docsDir, "note.md");
    writeFileSync(filePath, "This is a sentence. This is another sentence.");

    const result = await ingestion.ingest({ filePath });

    expect(result.errors).toEqual([]);
    expect(result.filesProcessed).toBe(1);
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    expect(result.memoryIds.length).toBe(result.chunks);
  });

  test("stored chunks are actually retrievable from the repository", async () => {
    const filePath = join(docsDir, "note.txt");
    writeFileSync(filePath, "Alpha content sentence one. Alpha content sentence two.");

    const result = await ingestion.ingest({ filePath, tags: ["alpha"] });

    expect(result.memoryIds.length).toBeGreaterThan(0);
    const stored = await repository.findById(result.memoryIds[0]!);
    expect(stored).not.toBeNull();
    expect(stored!.content.length).toBeGreaterThan(0);
  });

  test("chunk metadata carries source path, chunk_index, and tags", async () => {
    const filePath = join(docsDir, "tagged.md");
    writeFileSync(filePath, "One sentence here. Another sentence follows.");

    const result = await ingestion.ingest({ filePath, tags: ["docs", "important"] });

    const stored = await repository.findById(result.memoryIds[0]!);
    expect(stored).not.toBeNull();
    expect(stored!.metadata.source).toBe(filePath);
    expect(stored!.metadata.chunk_index).toBe(0);
    expect(stored!.metadata.total_chunks).toBe(result.chunks);
    expect(stored!.metadata.tags).toEqual(["docs", "important"]);
    expect(stored!.metadata.type).toBe("document");
  });

  test("ingests a directory, only picking matching extensions", async () => {
    writeFileSync(join(docsDir, "a.md"), "Markdown file content sentence.");
    writeFileSync(join(docsDir, "b.txt"), "Text file content sentence.");
    writeFileSync(join(docsDir, "c.png"), "not-a-real-image-but-wrong-extension");
    writeFileSync(join(docsDir, "d.json"), JSON.stringify({ hello: "world" }));

    const result = await ingestion.ingest({ directoryPath: docsDir });

    expect(result.errors).toEqual([]);
    expect(result.filesProcessed).toBe(3); // md, txt, json — not png
  });

  test("respects maxFiles cap in directory mode", async () => {
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(docsDir, `file-${i}.txt`), `Content of file number ${i}.`);
    }

    const result = await ingestion.ingest({ directoryPath: docsDir, maxFiles: 2 });

    expect(result.filesProcessed).toBe(2);
  });

  test("skips node_modules, .git, and .vector-memory directories", async () => {
    const skipped = join(docsDir, "node_modules");
    mkdirSync(skipped, { recursive: true });
    writeFileSync(join(skipped, "ignored.md"), "Should not be ingested.");
    writeFileSync(join(docsDir, "real.md"), "Should be ingested sentence.");

    const result = await ingestion.ingest({ directoryPath: docsDir });

    expect(result.filesProcessed).toBe(1);
    const stored = await repository.findById(result.memoryIds[0]!);
    expect(stored!.metadata.source).toBe(join(docsDir, "real.md"));
  });

  test("JSON files are pretty-printed before chunking", async () => {
    const filePath = join(docsDir, "data.json");
    writeFileSync(filePath, JSON.stringify({ a: 1, b: { c: 2 } }));

    const result = await ingestion.ingest({ filePath });

    expect(result.errors).toEqual([]);
    expect(result.chunks).toBeGreaterThanOrEqual(1);
    const stored = await repository.findById(result.memoryIds[0]!);
    expect(stored!.content).toContain("\n"); // pretty-printed JSON has newlines
  });

  test("records a per-file error without aborting the whole run", async () => {
    const missingPath = join(docsDir, "does-not-exist.md");
    const goodPath = join(docsDir, "good.md");
    writeFileSync(goodPath, "This file exists and should ingest fine.");

    const missingResult = await ingestion.ingest({ filePath: missingPath });
    expect(missingResult.errors.length).toBe(1);
    expect(missingResult.filesProcessed).toBe(0);
    expect(missingResult.chunks).toBe(0);

    const goodResult = await ingestion.ingest({ filePath: goodPath });
    expect(goodResult.errors).toEqual([]);
    expect(goodResult.filesProcessed).toBe(1);
  });

  test("throws when neither filePath nor directoryPath is given", async () => {
    await expect(ingestion.ingest({})).rejects.toThrow();
  });

  test("throws when both filePath and directoryPath are given", async () => {
    const filePath = join(docsDir, "x.md");
    writeFileSync(filePath, "content.");
    await expect(
      ingestion.ingest({ filePath, directoryPath: docsDir }),
    ).rejects.toThrow();
  });

  test("stores each Markdown chunk with its document and section as context", async () => {
    const filePath = join(docsDir, "atlas.md");
    writeFileSync(
      filePath,
      "# Atlas Design\n\nAtlas syncs notes.\n\n## Auth\n\nTokens expire hourly.\n\n### Refresh\n\nRefresh tokens rotate.\n",
    );

    const result = await ingestion.ingest({ filePath });
    const stored = await repository.findByIds(result.memoryIds);
    const byContent = new Map(stored.map((m) => [m.content, m.context]));

    expect(byContent.get("Atlas syncs notes.")).toBe("Atlas Design");
    expect(byContent.get("Tokens expire hourly.")).toBe("Atlas Design > Auth");
    expect(byContent.get("Refresh tokens rotate.")).toBe("Atlas Design > Auth > Refresh");
  });

  test("a plain-text document's chunks carry its file name as context", async () => {
    const filePath = join(docsDir, "meeting-notes.txt");
    writeFileSync(filePath, "We agreed to ship on Friday.");

    const result = await ingestion.ingest({ filePath });
    const stored = await repository.findById(result.memoryIds[0]!);

    expect(stored!.context).toBe("meeting-notes");
  });
});

describe("markdownSections", () => {
  test("tracks the heading path, popping to the right level", () => {
    const sections = markdownSections("intro\n# A\none\n## B\ntwo\n# C\nthree");
    expect(sections).toEqual([
      { headings: [], text: "intro" },
      { headings: ["A"], text: "one" },
      { headings: ["A", "B"], text: "two" },
      { headings: ["C"], text: "three" },
    ]);
  });

  test("ignores heading-like lines inside fenced code and skips empty sections", () => {
    const sections = markdownSections("# Setup\n```sh\n# not a heading\n```\n## Empty\n## Usage\nRun it.");
    expect(sections).toEqual([
      { headings: ["Setup"], text: "```sh\n# not a heading\n```" },
      { headings: ["Setup", "Usage"], text: "Run it." },
    ]);
  });
});

describe("documentChunks", () => {
  test("takes the title from frontmatter and doesn't repeat a matching first heading", () => {
    const chunks = documentChunks("---\ntitle: Field Guide\n---\n# Field Guide\nBirds.\n## Owls\nThey hunt at night.", "/x/guide.md");
    expect(chunks.map((c) => c.context)).toEqual(["Field Guide", "Field Guide", "Field Guide > Owls"]);
  });
});
