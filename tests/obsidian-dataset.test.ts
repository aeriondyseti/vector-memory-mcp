import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadObsidianDataset } from "./benchmark/datasets/obsidian";
import { removeDir } from "./utils/test-helpers";

const BOILERPLATE =
  "This section details the character's complete life story and background, written as a template placeholder.";

const NOTES: Record<string, string> = {
  "World/Characters/Mira Vale.md": `---
title: "Mira Vale"
type: "character"
summary: "Mira Vale is a cartographer who mapped the drowned coast. She keeps her maps in the lighthouse."
home:
  - "[[World/Places/Saltmere|Saltmere]]"
---

## Background
${BOILERPLATE}

Mira grew up in [[World/Places/Saltmere|Saltmere]] and learned to chart tides from her father before the coast flooded.

## Statblock
> [!note]
> | STR | DEX |
> | 10 | 14 |

	## Secrets {toggle="true"}
	> [!note]- Secrets & Clues
	> - [ ] Mira forged the second map of the drowned coast to hide the reef passage.
	> - [ ] She owes a debt to the harbor guild.
`,
  "World/Characters/Oren Thal.md": `---
title: "Oren Thal"
type: "character"
---

## Background
${BOILERPLATE}

Oren is a smuggler who sails the reef passage at night and buys forged charts from [[Mira Vale]].
`,
  "World/Characters/Lessa Dune.md": `---
title: "Lessa Dune"
type: "character"
---

## Background
${BOILERPLATE}

Lessa commands the harbor guard and suspects that someone is selling charts of the reef.

> [!note]
> AC 15 | HP 40

## Notes
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.
`,
  "World/Places/Saltmere.md": `---
title: "Saltmere"
type: "location"
---

![harbor.png](https://example-bucket.s3.amazonaws.com/harbor.png?X-Amz-Signature=abcdef0123456789abcdef0123456789abcdef0123456789)

## Overview
Saltmere is a fishing town on the drowned coast, half its streets now under the tide line.
`,
  "Story/_Index.md": `# Story
- [[Mira Vale]]
- [[Oren Thal]]
`,
};

let vault: string;

beforeAll(() => {
  vault = mkdtempSync(join(tmpdir(), "obsidian-vault-"));
  for (const [path, text] of Object.entries(NOTES)) {
    mkdirSync(join(vault, path, ".."), { recursive: true });
    writeFileSync(join(vault, path), text);
  }
});

afterAll(() => removeDir(vault));

describe("loadObsidianDataset", () => {
  test("turns sections into memories, dropping boilerplate, statblocks and navigation", () => {
    const { dataset, stats } = loadObsidianDataset({ vaultPath: vault });
    const all = dataset.memories.map((m) => m.content).join("\n");

    expect(stats.notesScanned).toBe(4); // _Index.md skipped
    expect(all).not.toContain("template placeholder"); // in 3 notes: boilerplate
    expect(all).not.toContain("STR");
    expect(all).not.toContain("AC 15");
    expect(all).not.toMatch(/lorem ipsum/i);
    expect(all).not.toContain("toggle");
    expect(all).not.toContain("[ ]");
    expect(all).not.toContain("[[");
    expect(all).not.toContain("amazonaws"); // image-only intro dropped

    const mira = dataset.memories.filter((m) => m.metadata?.note === "World/Characters/Mira Vale");
    expect(mira.map((m) => m.content)).toEqual([
      "Background: Mira grew up in Saltmere and learned to chart tides from her father before the coast flooded.",
      "Secrets: Secrets & Clues:\n- Mira forged the second map of the drowned coast to hide the reef passage.\n- She owes a debt to the harbor guild.",
    ]);
  });

  test("links memories to the notes their wikilinks name, and frontmatter links as relations", () => {
    const { dataset } = loadObsidianDataset({ vaultPath: vault });
    const links = dataset.graph!.memoryLinks!;

    expect(links).toContainEqual({ memoryId: "World/Characters/Mira Vale#0", entityId: "World/Places/Saltmere" });
    expect(links).toContainEqual({ memoryId: "World/Characters/Oren Thal#0", entityId: "World/Characters/Mira Vale" });
    expect(links.some((l) => l.memoryId.startsWith("World/Characters/Mira Vale") && l.entityId === "World/Characters/Mira Vale")).toBe(false);
    expect(dataset.graph!.relations).toEqual([
      { from: "World/Characters/Mira Vale", to: "World/Places/Saltmere", type: "home" },
    ]);
    expect(dataset.graph!.entities.find((e) => e.id === "World/Places/Saltmere")).toMatchObject({
      name: "Saltmere",
      type: "location",
    });
  });

  test("membershipLinks also links each memory to its own note", () => {
    const { dataset } = loadObsidianDataset({ vaultPath: vault, membershipLinks: true });

    expect(dataset.graph!.memoryLinks).toContainEqual({
      memoryId: "World/Characters/Mira Vale#1",
      entityId: "World/Characters/Mira Vale",
    });
  });

  test("generates section, summary and title queries with membership ground truth", () => {
    const { dataset } = loadObsidianDataset({ vaultPath: vault, queriesPerCategory: 10 });
    const of = (category: string) => dataset.queries.filter((q) => q.category === category);

    expect(of("exact_match").map((q) => q.query)).toContain("Mira Vale: Secrets");
    expect(of("semantic")).toEqual([
      {
        id: "vault-summary-0",
        query: "Mira Vale is a cartographer who mapped the drowned coast.",
        relevantMemoryIds: ["World/Characters/Mira Vale#0", "World/Characters/Mira Vale#1"],
        partiallyRelevantIds: [],
        category: "semantic",
      },
    ]);
    expect(of("related_concept").map((q) => q.query)).toEqual(["What do we know about Mira Vale?"]);
    expect(of("negative").length).toBeGreaterThan(0);
  });

  test("resolves bespoke questions to sections, dropping ones that do not resolve", () => {
    const file = join(vault, "..", `bespoke-${Date.now()}.json`);
    writeFileSync(
      file,
      JSON.stringify([
        {
          id: "q1",
          query: "What did the cartographer hide on her second map?",
          kind: "factual",
          answers: [{ note: "World/Characters/Mira Vale", heading: "Secrets" }],
          supporting: [{ note: "World/Characters/Mira Vale", heading: "Background" }],
        },
        {
          id: "q2",
          query: "Who buys forged charts?",
          kind: "relational",
          answers: [{ note: "World/Characters/Oren Thal", heading: null }],
        },
        {
          id: "q3",
          query: "Mistyped section",
          kind: "factual",
          answers: [{ note: "World/Characters/Mira Vale", heading: "Secretz" }],
        },
      ]),
    );

    const { dataset, stats } = loadObsidianDataset({ vaultPath: vault, bespokeFile: file });
    const bespoke = dataset.queries.filter((q) => q.category === "bespoke");

    expect(bespoke).toEqual([
      {
        id: "bespoke-q1",
        query: "What did the cartographer hide on her second map?",
        relevantMemoryIds: ["World/Characters/Mira Vale#1"],
        partiallyRelevantIds: ["World/Characters/Mira Vale#0"],
        category: "bespoke",
        kind: "factual",
      },
      {
        id: "bespoke-q2",
        query: "Who buys forged charts?",
        relevantMemoryIds: ["World/Characters/Oren Thal#0"],
        partiallyRelevantIds: [],
        category: "bespoke",
        kind: "relational",
      },
    ]);
    expect(stats.bespoke).toEqual({
      inFile: 3,
      kept: 2,
      dropped: [{ id: "q3", reason: 'no memory for section "Secretz" of "World/Characters/Mira Vale"' }],
    });
    removeDir(file);
  });

  test("samples the same queries for the same seed", () => {
    const a = loadObsidianDataset({ vaultPath: vault, queriesPerCategory: 1, seed: 7 }).dataset.queries;
    const b = loadObsidianDataset({ vaultPath: vault, queriesPerCategory: 1, seed: 7 }).dataset.queries;

    expect(a).toEqual(b);
  });
});
