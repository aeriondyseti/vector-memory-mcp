import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Database } from "bun:sqlite";
import { connectToDatabase } from "../server/core/connection.js";
import { MemoryRepository } from "../server/core/memory.repository.js";
import { EmbeddingsService } from "../server/core/embeddings.service.js";
import { MemoryService } from "../server/core/memory.service.js";

describe("MemoryService - Usefulness", () => {
    let db: Database;
    let repository: MemoryRepository;
    let embeddings: EmbeddingsService;
    let service: MemoryService;
    let tmpDir: string;
    let dbPath: string;

    beforeEach(async () => {
        tmpDir = mkdtempSync(join(tmpdir(), "vector-memory-mcp-test-usefulness-"));
        dbPath = join(tmpDir, "test.db");
        db = connectToDatabase(dbPath);
        repository = new MemoryRepository(db);
        embeddings = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
        service = new MemoryService(repository, embeddings);
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true });
    });

    test("initial usefulness is 0", async () => {
        const memory = await service.store("test content");
        expect(memory.usefulness).toBe(0);

        const retrieved = await service.get(memory.id);
        expect(retrieved?.usefulness).toBe(0);
    });

    test("can report memory as useful", async () => {
        const memory = await service.store("test content");

        // Vote +1
        const updated = await service.vote(memory.id, 1);

        expect(updated).not.toBeNull();
        expect(updated!.usefulness).toBe(1);

        const retrieved = await service.get(memory.id);
        expect(retrieved!.usefulness).toBe(1);
    });

    test("can report memory as not useful", async () => {
        const memory = await service.store("test content");

        // Vote -1
        const updated = await service.vote(memory.id, -1);

        expect(updated).not.toBeNull();
        expect(updated!.usefulness).toBe(-1);

        const retrieved = await service.get(memory.id);
        expect(retrieved!.usefulness).toBe(-1);
    });

    test("can change vote", async () => {
        const memory = await service.store("test content");

        // Initial vote +1
        await service.vote(memory.id, 1);

        // Vote -1 (decrement)
        const updated = await service.vote(memory.id, -1);

        expect(updated!.usefulness).toBe(0);

        const retrieved = await service.get(memory.id);
        expect(retrieved!.usefulness).toBe(0);
    });

    test("returns null when voting for non-existent memory", async () => {
        const result = await service.vote("non-existent-id", 1);
        expect(result).toBeNull();
    });
});
