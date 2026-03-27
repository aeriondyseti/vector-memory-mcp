import * as ort from "onnxruntime-node";
import { Tokenizer } from "@huggingface/tokenizers";
import { join, dirname } from "path";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";

const HF_CDN = "https://huggingface.co";
const MAX_SEQ_LENGTH = 512;

export class EmbeddingsService {
  private modelName: string;
  private session: ort.InferenceSession | null = null;
  private tokenizer: Tokenizer | null = null;
  private initPromise: Promise<void> | null = null;
  private _dimension: number;

  constructor(modelName: string, dimension: number) {
    this.modelName = modelName;
    this._dimension = dimension;
  }

  get dimension(): number {
    return this._dimension;
  }

  get isReady(): boolean {
    return this.session !== null;
  }

  async warmup(): Promise<void> {
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.session) return;
    if (!this.initPromise) {
      this.initPromise = this._init();
    }
    await this.initPromise;
  }

  private get cacheDir(): string {
    const packageRoot = join(dirname(Bun.main), "..");
    return join(packageRoot, ".cache", "models", this.modelName);
  }

  private async downloadIfMissing(fileName: string): Promise<string> {
    const filePath = join(this.cacheDir, fileName);
    if (existsSync(filePath)) return filePath;

    const url = `${HF_CDN}/${this.modelName}/resolve/main/${fileName}`;
    await mkdir(dirname(filePath), { recursive: true });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
    const buffer = await response.arrayBuffer();
    await Bun.write(filePath, buffer);
    return filePath;
  }

  private async _init(): Promise<void> {
    const modelPath = await this.downloadIfMissing("onnx/model.onnx");
    const tokenizerJsonPath = await this.downloadIfMissing("tokenizer.json");
    const tokenizerConfigPath = await this.downloadIfMissing("tokenizer_config.json");

    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
    });

    const tokenizerJson = await Bun.file(tokenizerJsonPath).json();
    const tokenizerConfig = await Bun.file(tokenizerConfigPath).json();
    this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  }

  async embed(text: string): Promise<number[]> {
    await this.initialize();

    const encoded = this.tokenizer!.encode(text);

    // Truncate to model's max sequence length
    const seqLen = Math.min(encoded.ids.length, MAX_SEQ_LENGTH);
    const ids = encoded.ids.slice(0, seqLen);
    const mask = encoded.attention_mask.slice(0, seqLen);

    const inputIds = BigInt64Array.from(ids.map(BigInt));
    const attentionMask = BigInt64Array.from(mask.map(BigInt));
    const tokenTypeIds = new BigInt64Array(seqLen); // zeros for single-sequence input

    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor("int64", inputIds, [1, seqLen]),
      attention_mask: new ort.Tensor("int64", attentionMask, [1, seqLen]),
      token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, seqLen]),
    };

    const output = await this.session!.run(feeds);
    const lastHidden = output["last_hidden_state"];

    const pooled = this.meanPool(lastHidden.data as Float32Array, mask, seqLen);
    return this.normalize(pooled);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  private meanPool(data: Float32Array, mask: number[], seqLen: number): number[] {
    const dim = this._dimension;
    const expectedLen = seqLen * dim;
    if (data.length < expectedLen) {
      throw new Error(
        `ONNX output size ${data.length} < expected ${expectedLen} (seqLen=${seqLen}, dim=${dim}). Model/dimension mismatch?`,
      );
    }
    const pooled = new Array(dim).fill(0);
    let maskSum = 0;
    for (let t = 0; t < seqLen; t++) {
      if (mask[t]) {
        maskSum += 1;
        for (let d = 0; d < dim; d++) {
          pooled[d] += data[t * dim + d];
        }
      }
    }
    for (let d = 0; d < dim; d++) {
      pooled[d] /= maskSum;
    }
    return pooled;
  }

  private normalize(vec: number[]): number[] {
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    return vec.map(v => v / norm);
  }
}
