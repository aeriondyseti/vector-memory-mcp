import { describe, expect, test, beforeAll } from "bun:test";
import { EmbeddingsService } from "../server/core/embeddings.service";
import {
  isModelAvailable,
  createEmbeddingsService,
  testWithModel,
} from "./utils/model-loader";

describe("EmbeddingsService", () => {
  let service: EmbeddingsService;

  beforeAll(() => {
    if (isModelAvailable()) {
      service = createEmbeddingsService();
    }
  });

  describe("constructor", () => {
    test("sets dimension from constructor", () => {
      const s = new EmbeddingsService("Xenova/all-MiniLM-L6-v2", 384);
      expect(s.dimension).toBe(384);
    });
  });

  describe("dimension", () => {
    testWithModel("returns configured dimension", () => {
      expect(service.dimension).toBe(384);
    });
  });

  describe("embed", () => {
    testWithModel("returns array of correct dimension", async () => {
      const embedding = await service.embed("hello world");
      expect(embedding).toBeArray();
      expect(embedding.length).toBe(384);
    });

    testWithModel("returns numbers in reasonable range", async () => {
      const embedding = await service.embed("test text");
      for (const value of embedding) {
        expect(typeof value).toBe("number");
        expect(Math.abs(value)).toBeLessThan(10);
      }
    });

    testWithModel("produces different embeddings for different texts", async () => {
      const embedding1 = await service.embed("hello world");
      const embedding2 = await service.embed("goodbye universe");

      let hasDifference = false;
      for (let i = 0; i < embedding1.length; i++) {
        if (Math.abs(embedding1[i] - embedding2[i]) > 0.01) {
          hasDifference = true;
          break;
        }
      }
      expect(hasDifference).toBe(true);
    });

    testWithModel("produces similar embeddings for similar texts", async () => {
      const embedding1 = await service.embed("the cat sat on the mat");
      const embedding2 = await service.embed("a cat sitting on a mat");

      let dotProduct = 0;
      let norm1 = 0;
      let norm2 = 0;
      for (let i = 0; i < embedding1.length; i++) {
        dotProduct += embedding1[i] * embedding2[i];
        norm1 += embedding1[i] * embedding1[i];
        norm2 += embedding2[i] * embedding2[i];
      }
      const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));

      expect(similarity).toBeGreaterThan(0.8);
    });
  });

  describe("embedBatch", () => {
    testWithModel("returns array of embeddings", async () => {
      const embeddings = await service.embedBatch(["hello", "world"]);
      expect(embeddings).toBeArray();
      expect(embeddings.length).toBe(2);
      expect(embeddings[0].length).toBe(384);
      expect(embeddings[1].length).toBe(384);
    });

    testWithModel("handles empty array", async () => {
      const embeddings = await service.embedBatch([]);
      expect(embeddings).toBeArray();
      expect(embeddings.length).toBe(0);
    });

    testWithModel("produces same results as individual embed calls", async () => {
      const texts = ["hello", "world"];
      const batchEmbeddings = await service.embedBatch(texts);
      const individualEmbeddings = await Promise.all(
        texts.map((t) => service.embed(t))
      );

      for (let i = 0; i < texts.length; i++) {
        for (let j = 0; j < 384; j++) {
          expect(batchEmbeddings[i][j]).toBeCloseTo(individualEmbeddings[i][j], 5);
        }
      }
    });

    testWithModel("handles single-item batch", async () => {
      const batchResult = await service.embedBatch(["single text"]);
      const directResult = await service.embed("single text");

      expect(batchResult.length).toBe(1);
      expect(batchResult[0].length).toBe(384);

      // Verify it matches direct embed() call
      for (let i = 0; i < 384; i++) {
        expect(batchResult[0][i]).toBeCloseTo(directResult[i], 5);
      }
    });

    testWithModel("maintains order of results", async () => {
      const texts = ["first", "second", "third"];
      const batchEmbeddings = await service.embedBatch(texts);

      // Get individual embeddings in same order
      const firstEmbed = await service.embed("first");
      const secondEmbed = await service.embed("second");
      const thirdEmbed = await service.embed("third");

      // Verify order is maintained
      for (let i = 0; i < 384; i++) {
        expect(batchEmbeddings[0][i]).toBeCloseTo(firstEmbed[i], 5);
        expect(batchEmbeddings[1][i]).toBeCloseTo(secondEmbed[i], 5);
        expect(batchEmbeddings[2][i]).toBeCloseTo(thirdEmbed[i], 5);
      }
    });
  });

  describe("extractor caching", () => {
    testWithModel("reuses cached extractor for multiple calls", async () => {
      const freshService = createEmbeddingsService();

      // First call initializes
      const start1 = performance.now();
      await freshService.embed("first call");
      const duration1 = performance.now() - start1;

      // Second call should use cached extractor (much faster)
      const start2 = performance.now();
      await freshService.embed("second call");
      const duration2 = performance.now() - start2;

      // Third call should also use cached extractor
      await freshService.embed("third call");

      // Cached calls should be significantly faster
      // (First call includes model loading time)
      expect(duration2).toBeLessThan(duration1 / 2);
    });

    testWithModel("handles concurrent initialization safely", async () => {
      const freshService = createEmbeddingsService();

      // Make multiple simultaneous embed calls before model is loaded
      const promises = [
        freshService.embed("concurrent 1"),
        freshService.embed("concurrent 2"),
        freshService.embed("concurrent 3"),
        freshService.embed("concurrent 4"),
      ];

      const results = await Promise.all(promises);

      // All should succeed
      expect(results.length).toBe(4);
      results.forEach((embedding) => {
        expect(embedding.length).toBe(384);
        expect(embedding).toBeArray();
      });
    });

    testWithModel("extractor persists across multiple operations", async () => {
      const freshService = createEmbeddingsService();

      // First operation
      const embed1 = await freshService.embed("test 1");
      expect(embed1.length).toBe(384);

      // Batch operation
      const batch = await freshService.embedBatch(["test 2", "test 3"]);
      expect(batch.length).toBe(2);

      // Another single operation
      const embed2 = await freshService.embed("test 4");
      expect(embed2.length).toBe(384);

      // All operations should complete successfully with cached extractor
    });
  });

  describe("edge cases", () => {
    testWithModel("handles empty string", async () => {
      const embedding = await service.embed("");
      expect(embedding).toBeArray();
      expect(embedding.length).toBe(384);

      // Should return valid numbers
      embedding.forEach((value) => {
        expect(typeof value).toBe("number");
        expect(isNaN(value)).toBe(false);
      });
    });

    testWithModel("handles very long text", async () => {
      // Create a very long string (10000+ characters)
      const longText = "This is a test sentence. ".repeat(500);
      expect(longText.length).toBeGreaterThan(10000);

      const embedding = await service.embed(longText);
      expect(embedding).toBeArray();
      expect(embedding.length).toBe(384);

      // Verify valid output
      embedding.forEach((value) => {
        expect(typeof value).toBe("number");
        expect(isNaN(value)).toBe(false);
      });
    });

    testWithModel("handles special characters and Unicode", async () => {
      const specialText = "Hello 🌍! Testing émojis 中文 and symbols: @#$%^&*()";
      const embedding = await service.embed(specialText);

      expect(embedding).toBeArray();
      expect(embedding.length).toBe(384);

      // Should produce valid embeddings
      embedding.forEach((value) => {
        expect(typeof value).toBe("number");
        expect(isNaN(value)).toBe(false);
        expect(Math.abs(value)).toBeLessThan(10);
      });
    });

    testWithModel("handles whitespace-only text", async () => {
      const whitespaceText = "   \t\n   ";
      const embedding = await service.embed(whitespaceText);

      expect(embedding).toBeArray();
      expect(embedding.length).toBe(384);

      // Should return valid numbers
      embedding.forEach((value) => {
        expect(typeof value).toBe("number");
        expect(isNaN(value)).toBe(false);
      });
    });

    testWithModel("handles text with newlines and tabs", async () => {
      const multilineText = "First line\nSecond line\n\tIndented line\n\n\nMultiple breaks";
      const embedding = await service.embed(multilineText);

      expect(embedding).toBeArray();
      expect(embedding.length).toBe(384);

      embedding.forEach((value) => {
        expect(typeof value).toBe("number");
        expect(Math.abs(value)).toBeLessThan(10);
      });
    });
  });

  describe("service independence", () => {
    testWithModel("multiple service instances work independently", async () => {
      const service1 = createEmbeddingsService();
      const service2 = createEmbeddingsService();

      // Both services should work independently
      const [embed1, embed2] = await Promise.all([
        service1.embed("test from service 1"),
        service2.embed("test from service 2"),
      ]);

      expect(embed1.length).toBe(384);
      expect(embed2.length).toBe(384);

      // Services should produce same results for same input
      const [embed1Same, embed2Same] = await Promise.all([
        service1.embed("identical text"),
        service2.embed("identical text"),
      ]);

      for (let i = 0; i < 384; i++) {
        expect(embed1Same[i]).toBeCloseTo(embed2Same[i], 5);
      }
    });
  });
});
