/**
 * ConvoMem Data Source
 *
 * Salesforce ConvoMem benchmark — conversational memory evaluation with
 * 75K QA pairs across 6 evidence categories.
 *
 * Adapts ConvoMem for retrieval-only evaluation: evidence messages become
 * stored memories, filler conversation messages become distractors, and
 * questions become search queries.
 *
 * @see https://huggingface.co/datasets/Salesforce/ConvoMem
 * @license Apache 2.0
 */

import type { BenchmarkDataset, GroundTruthMemory, GroundTruthQuery, QueryCategory } from "../../types";
import { Sampler } from "../sampler";
import type { DataSource, FetchOptions, RawSample, ConvertOptions } from "../types";
import { registerSource } from "../index";

const HF_BASE = "https://huggingface.co/datasets/Salesforce/ConvoMem/resolve/main";

/**
 * ConvoMem evidence categories and their mapping to our QueryCategory.
 */
const EVIDENCE_CATEGORIES = {
  user_evidence: "exact_match",
  assistant_facts_evidence: "exact_match",
  preference_evidence: "semantic",
  changing_evidence: "semantic",
  implicit_connection_evidence: "related_concept",
  abstention_evidence: "negative",
} as const satisfies Record<string, QueryCategory>;

/** Some categories start at 2_evidence instead of 1_evidence */
const MIN_EVIDENCE_COUNT: Partial<Record<ConvoMemCategory, number>> = {
  changing_evidence: 2,
};

type ConvoMemCategory = keyof typeof EVIDENCE_CATEGORIES;

/**
 * ConvoMem JSON structure for a single evidence item.
 */
interface ConvoMemEvidenceItem {
  question: string;
  answer: string;
  message_evidences: Array<{ speaker: string; text: string }>;
  conversations: Array<{
    messages: Array<{ speaker: string; text: string }>;
    id: string;
    containsEvidence: boolean;
    model_name: string;
  }>;
  category?: string;
  scenario_description?: string;
  personId: string;
  use_case_model_name?: string;
  core_model_name?: string;
}

interface ConvoMemFile {
  evidence_items: ConvoMemEvidenceItem[];
}

/**
 * A known persona file for deterministic fetching.
 * Using a small set to keep download size manageable.
 */
const SAMPLE_PERSONAS = [
  "0050e213-5032-42a0-8041-b5eef2f8ab91_Telemarketer",
  "29eb193c-9192-4741-bd11-47f2a2ac0ae1_Salesforce_Administrator",
  "419774f1-7859-4431-bc6d-1b77e6d51b01_Small_Business_Owner",
  "830cac24-5955-4b73-b1ac-76a541a87175_Financial_Advisor",
  "cc44dac1-5163-40a5-bec4-134417506112_Real_Estate_Agent",
];

/**
 * Fetch a JSON file from HuggingFace with retry.
 */
async function fetchHF<T>(path: string): Promise<T> {
  const url = `${HF_BASE}/${path}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return await response.json() as T;
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("unreachable");
}

/**
 * ConvoMem data source implementation.
 */
export class ConvoMemSource implements DataSource {
  readonly name = "convomem";
  readonly description = "Salesforce ConvoMem — conversational memory QA pairs with filler noise";
  readonly category = "context" as const;
  readonly license = "Apache 2.0";

  /**
   * Fetch evidence items and filler conversations from ConvoMem.
   *
   * Strategy:
   * - Fetch 1-evidence items from a few personas across all 6 categories
   * - Fetch filler conversations from those same personas
   * - Sample to requested limit while maintaining category balance
   *
   * Each RawSample represents one evidence item with its question.
   * Filler items have no queries (they're pure noise).
   */
  async fetch(options: FetchOptions): Promise<RawSample[]> {
    const { limit, seed = 42 } = options;
    const sampler = new Sampler(seed);

    // Determine how many personas we need
    const categories = Object.keys(EVIDENCE_CATEGORIES) as ConvoMemCategory[];
    const evidencePerCategory = Math.ceil(limit / categories.length);

    // Use up to 5 personas to get variety
    const personaCount = Math.min(SAMPLE_PERSONAS.length, Math.ceil(evidencePerCategory / 10));
    const selectedPersonas = sampler.sample(SAMPLE_PERSONAS, personaCount);

    console.log(`  ConvoMem: fetching from ${selectedPersonas.length} personas across ${categories.length} categories...`);

    // Fetch evidence items
    const allEvidence: RawSample[] = [];
    let evidenceCounter = 0;

    for (const category of categories) {
      const categoryItems: RawSample[] = [];

      const minEvidence = MIN_EVIDENCE_COUNT[category] ?? 1;

      for (const persona of selectedPersonas) {
        try {
          const path = `core_benchmark/evidence_questions/${category}/${minEvidence}_evidence/${persona}.json`;
          const data = await fetchHF<ConvoMemFile>(path);
          const isAbstention = category === "abstention_evidence";

          for (const item of data.evidence_items) {
            // Combine all evidence message texts into one memory
            const evidenceText = item.message_evidences
              .map((e) => e.text)
              .join(" ");

            if (!evidenceText.trim()) continue;

            const id = `convomem-ev-${category}-${evidenceCounter++}`;

            // For abstention: store evidence as context but queries have NO relevant IDs
            // (the question asks about something not in the evidence)
            const sample: RawSample = {
              id,
              content: evidenceText,
              metadata: {
                source: "convomem",
                category,
                personId: item.personId,
                scenarioDescription: item.scenario_description,
                answer: item.answer,
              },
              queries: isAbstention
                ? [
                    {
                      query: item.question,
                      answer: item.answer,
                      relevance: "low",
                      category: "negative" as QueryCategory,
                    },
                  ]
                : [
                    {
                      query: item.question,
                      answer: item.answer,
                      relevance: "high",
                      category: EVIDENCE_CATEGORIES[category],
                    },
                  ],
            };

            // For abstention, mark that queries should have no relevant memories
            if (isAbstention) {
              sample.metadata.abstention = true;
            }

            categoryItems.push(sample);
          }
        } catch (err) {
          console.warn(`  ConvoMem: failed to fetch ${category}/${persona}: ${err}`);
        }
      }

      // Sample from this category to maintain balance
      const sampled = sampler.sample(categoryItems, evidencePerCategory);
      allEvidence.push(...sampled);
    }

    // Fetch filler conversations as noise
    console.log(`  ConvoMem: fetching filler conversations...`);
    const allFillers: RawSample[] = [];
    let fillerCounter = 0;

    for (const persona of selectedPersonas) {
      try {
        const path = `core_benchmark/filler_conversations/${persona}.json`;
        const data = await fetchHF<ConvoMemFile>(path);

        // Extract individual messages as filler memories
        // Take a random sample of conversations, then pick messages from each
        const conversations = sampler.sample(data.evidence_items, 40);

        for (const item of conversations) {
          if (!item.conversations?.[0]?.messages) continue;

          // Pick 2-3 user messages from each conversation as noise memories
          const userMessages = item.conversations[0].messages
            .filter((m) => m.speaker === "User" && m.text.length > 30);

          const picked = sampler.sample(userMessages, Math.min(3, userMessages.length));
          for (const msg of picked) {
            allFillers.push({
              id: `convomem-filler-${fillerCounter++}`,
              content: msg.text,
              metadata: {
                source: "convomem-filler",
                personId: item.personId,
              },
              // No queries — pure noise
            });
          }
        }
      } catch (err) {
        console.warn(`  ConvoMem: failed to fetch fillers for ${persona}: ${err}`);
      }
    }

    // Target noise ratio: ~5x evidence count
    const noiseTarget = allEvidence.length * 5;
    const sampledFillers = sampler.sample(allFillers, Math.min(noiseTarget, allFillers.length));

    console.log(`  ConvoMem: ${allEvidence.length} evidence items, ${sampledFillers.length} fillers`);

    return [...allEvidence, ...sampledFillers];
  }

  /**
   * Convert raw samples to benchmark dataset format.
   */
  toDataset(samples: RawSample[], options: ConvertOptions = {}): BenchmarkDataset {
    const { idPrefix = "convomem" } = options;

    const memories: GroundTruthMemory[] = [];
    const queries: GroundTruthQuery[] = [];

    for (const sample of samples) {
      const memoryId = `${idPrefix}-${sample.id}`;

      memories.push({
        id: memoryId,
        content: sample.content,
        metadata: sample.metadata,
        domain: sample.queries ? "evidence" : "filler",
      });

      if (sample.queries) {
        const isAbstention = sample.metadata.abstention === true;
        for (let i = 0; i < sample.queries.length; i++) {
          const q = sample.queries[i];
          queries.push({
            id: `${memoryId}-q${i}`,
            query: q.query,
            // Abstention queries have no relevant memories — the answer isn't in any stored memory
            relevantMemoryIds: isAbstention ? [] : [memoryId],
            partiallyRelevantIds: [],
            category: q.category ?? "exact_match",
          });
        }
      }
    }

    return {
      name: `${idPrefix}-dataset`,
      description: `ConvoMem dataset (${memories.length} memories: ${memories.filter((m) => m.domain === "evidence").length} evidence + ${memories.filter((m) => m.domain === "filler").length} fillers, ${queries.length} queries)`,
      memories,
      queries,
    };
  }
}

export const convomemSource = new ConvoMemSource();
registerSource(convomemSource);
