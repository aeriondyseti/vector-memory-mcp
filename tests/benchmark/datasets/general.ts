/**
 * Comprehensive Ground Truth Dataset
 *
 * Covers diverse use cases with graded relevance levels:
 * - World-building/Lore: Aeloria (sunken city), Scarlet Covenant (vampires)
 * - Design Decisions: Database migration, UI component library
 * - Factual Knowledge: French Revolution, Quantum Mechanics
 * - Personal Context: Python project, Fitness routine
 *
 * Each memory has a relevance level (high/medium/low) for NDCG testing.
 * Distractors are included for negative testing.
 */

import type { BenchmarkDataset } from "../types";

export const generalDataset: BenchmarkDataset = {
  name: "general",
  description:
    "Domain-agnostic dataset with graded relevance and topic discrimination",

  memories: [
    // ============================================
    // WORLD-BUILDING / LORE - Topic A: Aeloria
    // ============================================
    {
      id: "aeloria-high-1",
      content:
        "Aeloria did not sink due to natural tectonic shifts. The Arch-Mage Varis explicitly noted in his journal (Entry 402) that the 'Weeping Stone' ritual was performed incorrectly, liquefying the bedrock beneath the cathedral district first.",
      metadata: { topic: "aeloria", relevance: "high" },
      domain: "lore",
    },
    {
      id: "aeloria-medium-1",
      content:
        "Current exports from the Aeloria ruins include bioluminescent moss and watertight chests. Scavengers report that the air pockets in the lower districts are becoming toxic.",
      metadata: { topic: "aeloria", relevance: "medium" },
      domain: "lore",
    },
    {
      id: "aeloria-low-1",
      content:
        "Architecture in pre-fall Aeloria was characterized by high spires and gargoyles designed to channel rainwater into distinct musical tones.",
      metadata: { topic: "aeloria", relevance: "low" },
      domain: "lore",
    },
    {
      id: "aeloria-high-2",
      content:
        "The location of the Lost Library is rumored to be in the Western Ward of Aeloria, currently guarded by a construct known as The Drowned Warden.",
      metadata: { topic: "aeloria", relevance: "high" },
      domain: "lore",
    },

    // ============================================
    // WORLD-BUILDING / LORE - Topic B: Scarlet Covenant
    // ============================================
    {
      id: "covenant-high-1",
      content:
        "The Scarlet Covenant strictly forbids the embrace of anyone holding political office. Violation results in the 'Sun-Walk' penalty. This rule was established in the Treaty of 1899.",
      metadata: { topic: "scarlet-covenant", relevance: "high" },
      domain: "lore",
    },
    {
      id: "covenant-medium-1",
      content:
        "Faction relations: The Scarlet Covenant is currently at war with the Lupine clans of the North but maintains a tenuous non-aggression pact with the Mages of the Circle.",
      metadata: { topic: "scarlet-covenant", relevance: "medium" },
      domain: "lore",
    },
    {
      id: "covenant-high-2",
      content:
        "Leader Profile: Matriarch Valerica. She values decorum and blood purity above all else. Do not approach her without a formal invitation sealed in wax.",
      metadata: { topic: "scarlet-covenant", relevance: "high" },
      domain: "lore",
    },
    {
      id: "covenant-low-1",
      content:
        "The Covenant's preferred meeting place is the basement of the 'Velvet Glove' jazz club, specifically on Tuesday nights.",
      metadata: { topic: "scarlet-covenant", relevance: "low" },
      domain: "lore",
    },

    // ============================================
    // DESIGN DECISIONS - Topic A: Database Migration
    // ============================================
    {
      id: "db-high-1",
      content:
        "Decision Record 004: We are migrating the User Profile data to MongoDB. Rationale: The schema for user preferences is too volatile and requires frequent column additions in Postgres, causing downtime.",
      metadata: { topic: "database", relevance: "high" },
      domain: "design",
    },
    {
      id: "db-high-2",
      content:
        "Trade-off: By moving to NoSQL for the activity feed, we accept eventual consistency. Real-time accuracy is less critical than read-throughput for this specific feature.",
      metadata: { topic: "database", relevance: "high" },
      domain: "design",
    },
    {
      id: "db-medium-1",
      content:
        "Migration Script Note: Ensure the `legacy_id` field is preserved during the JSON transformation to maintain backward compatibility with the analytics service.",
      metadata: { topic: "database", relevance: "medium" },
      domain: "design",
    },
    {
      id: "db-low-1",
      content:
        "Postgres 14 introduced better JSONB support, which we considered but ultimately rejected due to the team's familiarity with Mongo's aggregation pipeline.",
      metadata: { topic: "database", relevance: "low" },
      domain: "design",
    },

    // ============================================
    // DESIGN DECISIONS - Topic B: UI Component Library
    // ============================================
    {
      id: "ui-high-1",
      content:
        "We are adopting Material UI (MUI) for the admin dashboard to speed up development. The design team agreed that internal tools do not require a bespoke brand identity.",
      metadata: { topic: "ui-library", relevance: "high" },
      domain: "design",
    },
    {
      id: "ui-high-2",
      content:
        "Critical Design Choice: We will NOT use MUI for the customer-facing landing page. It looks too generic. We will build a custom lightweight component set using Tailwind CSS for the public site.",
      metadata: { topic: "ui-library", relevance: "high" },
      domain: "design",
    },
    {
      id: "ui-medium-1",
      content:
        "Issue #402: The DatePicker component in the current custom library has accessibility (a11y) violations. Switching to a vetted library solves this compliance risk.",
      metadata: { topic: "ui-library", relevance: "medium" },
      domain: "design",
    },
    {
      id: "ui-low-1",
      content:
        "Button hover states should have a 0.2s transition ease-in-out curve.",
      metadata: { topic: "ui-library", relevance: "low" },
      domain: "design",
    },

    // ============================================
    // FACTUAL KNOWLEDGE - Topic A: French Revolution
    // ============================================
    {
      id: "revolution-high-1",
      content:
        "The Storming of the Bastille occurred on July 14, 1789. It is considered the flashpoint of the French Revolution, symbolizing the collapse of royal authority.",
      metadata: { topic: "french-revolution", relevance: "high" },
      domain: "factual",
    },
    {
      id: "revolution-medium-1",
      content:
        "Maximilien Robespierre was a key figure in the Reign of Terror. His execution in July 1794 (Thermidorian Reaction) marked a turning point toward the establishment of the Directory.",
      metadata: { topic: "french-revolution", relevance: "medium" },
      domain: "factual",
    },
    {
      id: "revolution-high-2",
      content:
        "The Three Estates: 1st (Clergy), 2nd (Nobility), 3rd (Commoners). The Revolution was largely driven by the inequality of the tax burden placed solely on the Third Estate.",
      metadata: { topic: "french-revolution", relevance: "high" },
      domain: "factual",
    },
    {
      id: "revolution-low-1",
      content: "The Guillotine was nicknamed 'The National Razor'.",
      metadata: { topic: "french-revolution", relevance: "low" },
      domain: "factual",
    },

    // ============================================
    // FACTUAL KNOWLEDGE - Topic B: Quantum Mechanics
    // ============================================
    {
      id: "quantum-high-1",
      content:
        "Heisenberg's Uncertainty Principle states that one cannot simultaneously know the exact position and momentum of a particle. The more precisely one is known, the less precisely the other can be determined.",
      metadata: { topic: "quantum", relevance: "high" },
      domain: "factual",
    },
    {
      id: "quantum-medium-1",
      content:
        "Superposition is the ability of a quantum system to be in multiple states at the same time until it is measured. Schrödinger's Cat is a famous thought experiment illustrating this paradox.",
      metadata: { topic: "quantum", relevance: "medium" },
      domain: "factual",
    },
    {
      id: "quantum-high-2",
      content:
        "Quantum Entanglement: A phenomenon where particles become correlated in such a way that the quantum state of each particle cannot be described independently, even when separated by large distances.",
      metadata: { topic: "quantum", relevance: "high" },
      domain: "factual",
    },
    {
      id: "quantum-low-1",
      content:
        "Max Planck is considered the father of quantum theory, originating from his work on black-body radiation in 1900.",
      metadata: { topic: "quantum", relevance: "low" },
      domain: "factual",
    },
    {
      id: "quantum-medium-2",
      content:
        "Wave-particle duality suggests that all particles exhibit both wave and particle properties. This was demonstrated by the Double Slit Experiment.",
      metadata: { topic: "quantum", relevance: "medium" },
      domain: "factual",
    },

    // ============================================
    // PERSONAL CONTEXT - Topic A: Python Auto-Blogger
    // ============================================
    {
      id: "python-high-1",
      content:
        "User Preference: When generating Python code for the Auto-Blogger, always use `logging` instead of `print` statements. The user plans to deploy this on a headless server.",
      metadata: { topic: "python-project", relevance: "high" },
      domain: "context",
    },
    {
      id: "python-medium-1",
      content:
        "Context: The user previously struggled with the OpenAI API rate limits in the `text_generator.py` module and asked for a retry decorator using 'exponential backoff'.",
      metadata: { topic: "python-project", relevance: "medium" },
      domain: "context",
    },
    {
      id: "python-high-2",
      content:
        "Project Goal: The Auto-Blogger needs to scrape TechCrunch every morning at 8:00 AM, summarize the top 3 articles, and post them to a WordPress site.",
      metadata: { topic: "python-project", relevance: "high" },
      domain: "context",
    },
    {
      id: "python-low-1",
      content:
        "The user prefers using `venv` over `conda` for environment management.",
      metadata: { topic: "python-project", relevance: "low" },
      domain: "context",
    },

    // ============================================
    // PERSONAL CONTEXT - Topic B: Fitness Routine
    // ============================================
    {
      id: "fitness-high-1",
      content:
        "User Constraint: The user has a lower back injury (herniated disc). Exclude deadlifts and bent-over rows from any generated workout plans.",
      metadata: { topic: "fitness", relevance: "high" },
      domain: "context",
    },
    {
      id: "fitness-high-2",
      content:
        "Schedule: The user goes to the gym on Mon/Wed/Fri mornings. Tuesday and Thursday are reserved for cardio (running outside).",
      metadata: { topic: "fitness", relevance: "high" },
      domain: "context",
    },
    {
      id: "fitness-medium-1",
      content:
        "Goal: The current fitness goal is 'hypertrophy' (muscle gain), not strength or endurance. Rep ranges should be kept between 8-12.",
      metadata: { topic: "fitness", relevance: "medium" },
      domain: "context",
    },
    {
      id: "fitness-low-1",
      content:
        "The user tracks their protein intake and aims for 180g per day.",
      metadata: { topic: "fitness", relevance: "low" },
      domain: "context",
    },

    // ============================================
    // DISTRACTORS (Irrelevant content)
    // ============================================
    {
      id: "distractor-scifi",
      content:
        "Spacecraft Class-7 thrusters require a cool-down period of 4 minutes after warp jumps.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-tavern",
      content:
        "NPC Dialogue: 'Welcome to Joe's Tavern, we have the best ale in the sector!'",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-magic",
      content:
        "The magic system in the Western Continent relies on drawing geometric shapes in the sand, unlike the rune-casting of the North.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-server",
      content:
        "The server room AC unit must be kept at 68°F (20°C) to prevent thermal throttling.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-marketing",
      content:
        "The marketing team wants to change the logo color to 'Electric Lime' for Q3.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-code",
      content:
        "Code Comment: // TODO - Refactor this spaghetti code before deployment. It's a mess.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-sourdough",
      content:
        "A standard sourdough starter requires feeding every 12 hours if kept at room temperature.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-australia",
      content:
        "The capital of Australia is Canberra, not Sydney or Melbourne.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-mitochondria",
      content:
        "The mitochondria is the powerhouse of the cell, responsible for generating ATP.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-shellfish",
      content:
        "The user mentioned they are allergic to shellfish during the dinner planning conversation last week.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-birthday",
      content: "Reminder: Buy a birthday gift for Sarah before October 15th.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
    {
      id: "distractor-got",
      content:
        "Opinion: The user really hated the ending of the 'Game of Thrones' TV series.",
      metadata: { topic: "distractor", relevance: "none" },
      domain: "distractor",
    },
  ],

  queries: [
    // ============================================
    // EXACT MATCH QUERIES
    // ============================================
    {
      id: "exact-aeloria",
      query: "Aeloria sunken city",
      relevantMemoryIds: ["aeloria-high-1", "aeloria-high-2"],
      partiallyRelevantIds: ["aeloria-medium-1", "aeloria-low-1"],
      category: "exact_match",
    },
    {
      id: "exact-covenant",
      query: "Scarlet Covenant vampire rules",
      relevantMemoryIds: ["covenant-high-1", "covenant-high-2"],
      partiallyRelevantIds: ["covenant-medium-1", "covenant-low-1"],
      category: "exact_match",
    },
    {
      id: "exact-mongodb",
      query: "MongoDB migration decision",
      relevantMemoryIds: ["db-high-1", "db-high-2"],
      partiallyRelevantIds: ["db-medium-1", "db-low-1"],
      category: "exact_match",
    },
    {
      id: "exact-mui",
      query: "Material UI component library",
      relevantMemoryIds: ["ui-high-1", "ui-high-2"],
      partiallyRelevantIds: ["ui-medium-1"],
      category: "exact_match",
    },
    {
      id: "exact-bastille",
      query: "Storming of the Bastille French Revolution",
      relevantMemoryIds: ["revolution-high-1"],
      partiallyRelevantIds: ["revolution-high-2", "revolution-medium-1"],
      category: "exact_match",
    },
    {
      id: "exact-heisenberg",
      query: "Heisenberg Uncertainty Principle",
      relevantMemoryIds: ["quantum-high-1"],
      partiallyRelevantIds: ["quantum-high-2", "quantum-medium-1"],
      category: "exact_match",
    },
    {
      id: "exact-autoblogger",
      query: "Auto-Blogger Python project",
      relevantMemoryIds: ["python-high-1", "python-high-2"],
      partiallyRelevantIds: ["python-medium-1", "python-low-1"],
      category: "exact_match",
    },
    {
      id: "exact-backinjury",
      query: "back injury workout restrictions",
      relevantMemoryIds: ["fitness-high-1"],
      partiallyRelevantIds: ["fitness-high-2", "fitness-medium-1"],
      category: "exact_match",
    },

    // ============================================
    // SEMANTIC QUERIES (paraphrased)
    // ============================================
    {
      id: "sem-aeloria-cause",
      query: "why did the city sink underwater",
      relevantMemoryIds: ["aeloria-high-1"],
      partiallyRelevantIds: ["aeloria-medium-1"],
      category: "semantic",
    },
    {
      id: "sem-covenant-leader",
      query: "who leads the vampire faction",
      relevantMemoryIds: ["covenant-high-2"],
      partiallyRelevantIds: ["covenant-high-1", "covenant-medium-1"],
      category: "semantic",
    },
    {
      id: "sem-db-tradeoff",
      query: "what consistency trade-offs did we accept",
      relevantMemoryIds: ["db-high-2"],
      partiallyRelevantIds: ["db-high-1"],
      category: "semantic",
    },
    {
      id: "sem-ui-publicsite",
      query: "what frontend framework for customer-facing pages",
      relevantMemoryIds: ["ui-high-2"],
      partiallyRelevantIds: ["ui-high-1"],
      category: "semantic",
    },
    {
      id: "sem-revolution-cause",
      query: "what caused the uprising in France",
      relevantMemoryIds: ["revolution-high-2", "revolution-high-1"],
      partiallyRelevantIds: ["revolution-medium-1"],
      category: "semantic",
    },
    {
      id: "sem-quantum-spooky",
      query: "how can particles affect each other at a distance",
      relevantMemoryIds: ["quantum-high-2"],
      partiallyRelevantIds: ["quantum-medium-1"],
      category: "semantic",
    },
    {
      id: "sem-python-schedule",
      query: "when does the blog scraper run",
      relevantMemoryIds: ["python-high-2"],
      partiallyRelevantIds: ["python-high-1"],
      category: "semantic",
    },
    {
      id: "sem-fitness-schedule",
      query: "what days does the user exercise",
      relevantMemoryIds: ["fitness-high-2"],
      partiallyRelevantIds: ["fitness-medium-1"],
      category: "semantic",
    },

    // ============================================
    // RELATED CONCEPT QUERIES
    // ============================================
    {
      id: "rel-aeloria-library",
      query: "where to find ancient books in the ruins",
      relevantMemoryIds: ["aeloria-high-2"],
      partiallyRelevantIds: ["aeloria-high-1"],
      category: "related_concept",
    },
    {
      id: "rel-covenant-politics",
      query: "vampire political restrictions",
      relevantMemoryIds: ["covenant-high-1"],
      partiallyRelevantIds: ["covenant-high-2"],
      category: "related_concept",
    },
    {
      id: "rel-db-compatibility",
      query: "how to maintain backwards compatibility during migration",
      relevantMemoryIds: ["db-medium-1"],
      partiallyRelevantIds: ["db-high-1", "db-high-2"],
      category: "related_concept",
    },
    {
      id: "rel-ui-accessibility",
      query: "component accessibility compliance issues",
      relevantMemoryIds: ["ui-medium-1"],
      partiallyRelevantIds: ["ui-high-1"],
      category: "related_concept",
    },
    {
      id: "rel-revolution-terror",
      query: "violent period after the revolution began",
      relevantMemoryIds: ["revolution-medium-1"],
      partiallyRelevantIds: ["revolution-high-1"],
      category: "related_concept",
    },
    {
      id: "rel-quantum-measurement",
      query: "what happens when you observe a quantum system",
      relevantMemoryIds: ["quantum-medium-1"],
      partiallyRelevantIds: ["quantum-high-1", "quantum-medium-2"],
      category: "related_concept",
    },
    {
      id: "rel-python-ratelimit",
      query: "handling API throttling in the project",
      relevantMemoryIds: ["python-medium-1"],
      partiallyRelevantIds: ["python-high-1"],
      category: "related_concept",
    },
    {
      id: "rel-fitness-goals",
      query: "what type of training for muscle building",
      relevantMemoryIds: ["fitness-medium-1"],
      partiallyRelevantIds: ["fitness-high-1", "fitness-high-2"],
      category: "related_concept",
    },

    // ============================================
    // TOPIC DISCRIMINATION QUERIES
    // Test that we can distinguish between similar topics
    // ============================================
    {
      id: "disc-lore-aeloria-not-covenant",
      query: "the Drowned Warden construct",
      relevantMemoryIds: ["aeloria-high-2"],
      partiallyRelevantIds: [],
      category: "semantic",
    },
    {
      id: "disc-lore-covenant-not-aeloria",
      query: "Matriarch Valerica leadership",
      relevantMemoryIds: ["covenant-high-2"],
      partiallyRelevantIds: [],
      category: "semantic",
    },
    {
      id: "disc-design-db-not-ui",
      query: "NoSQL eventual consistency decision",
      relevantMemoryIds: ["db-high-2"],
      partiallyRelevantIds: ["db-high-1"],
      category: "semantic",
    },
    {
      id: "disc-design-ui-not-db",
      query: "Tailwind CSS for landing page",
      relevantMemoryIds: ["ui-high-2"],
      partiallyRelevantIds: [],
      category: "semantic",
    },

    // ============================================
    // NEGATIVE QUERIES (out of domain)
    // ============================================
    {
      id: "neg-cooking",
      query: "best recipe for chocolate soufflé",
      relevantMemoryIds: [],
      category: "negative",
    },
    {
      id: "neg-sports",
      query: "World Cup soccer tournament results",
      relevantMemoryIds: [],
      category: "negative",
    },
    {
      id: "neg-finance",
      query: "stock market investment strategies",
      relevantMemoryIds: [],
      category: "negative",
    },
    {
      id: "neg-music",
      query: "how to play guitar chords",
      relevantMemoryIds: [],
      category: "negative",
    },

    // ============================================
    // EDGE CASE QUERIES
    // ============================================
    {
      id: "edge-short-1",
      query: "Aeloria",
      relevantMemoryIds: ["aeloria-high-1", "aeloria-high-2"],
      partiallyRelevantIds: ["aeloria-medium-1", "aeloria-low-1"],
      category: "edge_case",
    },
    {
      id: "edge-short-2",
      query: "MongoDB",
      relevantMemoryIds: ["db-high-1"],
      partiallyRelevantIds: ["db-high-2", "db-low-1"],
      category: "edge_case",
    },
    {
      id: "edge-long",
      query:
        "I need to understand the complete history of what happened to the sunken city, including the magical ritual that caused the catastrophe and where I can find the lost library with its guardian",
      relevantMemoryIds: ["aeloria-high-1", "aeloria-high-2"],
      partiallyRelevantIds: ["aeloria-medium-1"],
      category: "edge_case",
    },
    {
      id: "edge-symbols",
      query: "8-12 reps hypertrophy",
      relevantMemoryIds: ["fitness-medium-1"],
      partiallyRelevantIds: ["fitness-high-1"],
      category: "edge_case",
    },
    {
      id: "edge-mixed-case",
      query: "SCARLET COVENANT sun-walk penalty",
      relevantMemoryIds: ["covenant-high-1"],
      partiallyRelevantIds: ["covenant-high-2"],
      category: "edge_case",
    },
    {
      id: "edge-typo",
      query: "quantam entanglement particles",
      relevantMemoryIds: ["quantum-high-2"],
      partiallyRelevantIds: ["quantum-high-1"],
      category: "edge_case",
    },
  ],
};
