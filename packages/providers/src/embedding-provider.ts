import type { IModelProvider } from './model-provider';

export const EMBEDDING_DIMENSION = 1536;
export const DEFAULT_EMBEDDING_MODEL = 'openai/text-embedding-3-small';

export interface IEmbeddingProvider {
  embed(text: string | string[]): Promise<number[][]>;
  readonly dimension: number;
}

export class EmbeddingProvider implements IEmbeddingProvider {
  readonly dimension: number;

  constructor(
    private readonly modelProvider: IModelProvider,
    private readonly model: string = DEFAULT_EMBEDDING_MODEL,
    dimension: number = EMBEDDING_DIMENSION,
  ) {
    this.dimension = dimension;
  }

  async embed(text: string | string[]): Promise<number[][]> {
    const vectors = await this.modelProvider.embed({ model: this.model, input: text });
    for (const v of vectors) {
      if (v.length !== this.dimension) {
        throw new Error(
          `Embedding dimension mismatch: expected ${this.dimension}, got ${v.length}`,
        );
      }
    }
    return vectors;
  }
}
