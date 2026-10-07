import * as ort from "onnxruntime-node";
import type { Tokenizer } from "@huggingface/tokenizers";
import { loadOnnxModel } from "./embeddings.service";

/** A small cross-encoder trained on MS MARCO passage ranking: 6 layers, CPU-friendly. */
export const DEFAULT_RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

const MAX_SEQ_LENGTH = 512;
/** Pairs scored per model call: one padded batch amortizes the call overhead. */
const BATCH_SIZE = 16;
/** Text beyond this many characters is cut before tokenizing (memories are short; long ones are truncated anyway). */
const MAX_PASSAGE_CHARS = 2000;

/**
 * Cross-encoder reranker: reads a query and a passage together and scores
 * how well the passage answers the query — sharper than comparing their
 * separate embeddings, at the cost of one model pass per candidate.
 * Scores are logits: higher is more relevant, comparable within a query.
 */
export class RerankerService {
  private session: ort.InferenceSession | null = null;
  private tokenizer: Tokenizer | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private modelName: string = DEFAULT_RERANKER_MODEL) {}

  get isReady(): boolean {
    return this.session !== null;
  }

  async warmup(): Promise<void> {
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.session) return;
    this.initPromise ??= loadOnnxModel(this.modelName).then(({ session, tokenizer }) => {
      this.session = session;
      this.tokenizer = tokenizer;
    });
    await this.initPromise;
  }

  /** Relevance of each passage to the query, in the passages' order. */
  async score(query: string, passages: string[]): Promise<number[]> {
    if (passages.length === 0) return [];
    await this.initialize();
    const scores: number[] = [];
    for (let i = 0; i < passages.length; i += BATCH_SIZE) {
      scores.push(...(await this.scoreBatch(query, passages.slice(i, i + BATCH_SIZE))));
    }
    return scores;
  }

  private async scoreBatch(query: string, passages: string[]): Promise<number[]> {
    const encoded = passages.map((p) => {
      const e = this.tokenizer!.encode(query, {
        text_pair: p.slice(0, MAX_PASSAGE_CHARS),
        return_token_type_ids: true,
      });
      if (e.ids.length <= MAX_SEQ_LENGTH) return e;
      // Keep the final [SEP]: cut the passage's tail, not the pair's terminator.
      const cut = (xs: number[]) => [...xs.slice(0, MAX_SEQ_LENGTH - 1), xs[xs.length - 1]!];
      return { ids: cut(e.ids), attention_mask: cut(e.attention_mask), token_type_ids: cut(e.token_type_ids) };
    });

    const width = Math.max(...encoded.map((e) => e.ids.length));
    const size = passages.length * width;
    const ids = new BigInt64Array(size);
    const mask = new BigInt64Array(size);
    const types = new BigInt64Array(size);
    encoded.forEach((e, row) => {
      for (let t = 0; t < e.ids.length; t++) {
        ids[row * width + t] = BigInt(e.ids[t]!);
        mask[row * width + t] = BigInt(e.attention_mask[t]!);
        types[row * width + t] = BigInt(e.token_type_ids[t]!);
      }
    });

    const dims = [passages.length, width];
    const output = await this.session!.run({
      input_ids: new ort.Tensor("int64", ids, dims),
      attention_mask: new ort.Tensor("int64", mask, dims),
      token_type_ids: new ort.Tensor("int64", types, dims),
    });
    // One logit per pair: [batch, 1].
    return Array.from(output["logits"]!.data as Float32Array);
  }
}
