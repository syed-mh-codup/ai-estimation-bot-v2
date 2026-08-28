import { describe, it, expect, vi } from 'vitest';
import type { ChatOptions, IModelProvider } from '@repo/providers';
import { ingestFile, ingestFiles, type IngestFile } from './ingest';

const enc = (s: string) => new TextEncoder().encode(s);

/** Minimal stub: chat() returns a canned string; embed unused. */
function stubProvider(chat: (o: ChatOptions) => Promise<string> | string): IModelProvider {
  return {
    chat: vi.fn(async (o: ChatOptions) => chat(o)),
    chatStream: vi.fn(),
    embed: vi.fn(async () => [[0]]),
  };
}

describe('ingest: text + unknown (no LLM)', () => {
  it('decodes a .txt file directly without calling the model', async () => {
    const provider = stubProvider(() => 'SHOULD NOT BE CALLED');
    const file: IngestFile = { filename: 'sow.txt', mimeType: 'text/plain', bytes: enc('hello world') };
    const out = await ingestFile(file, { modelProvider: provider });
    expect(out.kind).toBe('text');
    expect(out.text).toBe('hello world');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('treats an unknown extension as UTF-8 text', async () => {
    const file: IngestFile = { filename: 'notes.xyz', mimeType: '', bytes: enc('raw notes') };
    const out = await ingestFile(file, { modelProvider: stubProvider(() => '') });
    expect(out.kind).toBe('unknown');
    expect(out.text).toBe('raw notes');
  });
});

describe('ingest: image (vision)', () => {
  it('sends an image_url data URL and returns the transcription', async () => {
    let seen: ChatOptions | undefined;
    const provider = stubProvider((o) => {
      seen = o;
      return 'A red square diagram';
    });
    const file: IngestFile = { filename: 'diagram.png', mimeType: 'image/png', bytes: enc('PNGDATA') };
    const out = await ingestFile(file, { modelProvider: provider, visionModel: 'vis/model' });

    expect(out.kind).toBe('image');
    expect(out.text).toBe('A red square diagram');
    expect(seen?.model).toBe('vis/model');
    const parts = seen?.messages[0]?.content;
    expect(Array.isArray(parts)).toBe(true);
    const img = (parts as Array<{ type: string; image_url?: { url: string } }>).find((p) => p.type === 'image_url');
    expect(img?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('ingest: pdf (file-parser plugin + engine fallback)', () => {
  it('passes the file-parser plugin and a file content part', async () => {
    let seen: ChatOptions | undefined;
    const provider = stubProvider((o) => {
      seen = o;
      return 'Parsed PDF content';
    });
    const file: IngestFile = { filename: 'brd.pdf', mimeType: 'application/pdf', bytes: enc('%PDF-1.4') };
    const out = await ingestFile(file, { modelProvider: provider });

    expect(out.kind).toBe('pdf');
    expect(out.text).toBe('Parsed PDF content');
    expect(seen?.plugins?.[0]).toMatchObject({ id: 'file-parser' });
    const parts = seen?.messages[0]?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'file')).toBe(true);
  });

  it('falls back to pdf-text when the OCR engine fails', async () => {
    const engines: string[] = [];
    const provider = stubProvider((o) => {
      const engine = (o.plugins?.[0] as { pdf?: { engine?: string } })?.pdf?.engine ?? '';
      engines.push(engine);
      if (engine === 'mistral-ocr') throw new Error('engine unavailable');
      return 'fallback text';
    });
    const file: IngestFile = { filename: 'brd.pdf', mimeType: 'application/pdf', bytes: enc('%PDF') };
    const out = await ingestFile(file, { modelProvider: provider });

    expect(engines).toEqual(['mistral-ocr', 'pdf-text']);
    expect(out.text).toBe('fallback text');
    expect(out.error).toBeUndefined();
  });
});

describe('ingest: error capture + batch', () => {
  it('captures a per-file error instead of throwing', async () => {
    const provider = stubProvider(() => {
      throw new Error('vision down');
    });
    const file: IngestFile = { filename: 'x.png', mimeType: 'image/png', bytes: enc('x') };
    const out = await ingestFile(file, { modelProvider: provider });
    expect(out.text).toBe('');
    expect(out.error).toContain('vision down');
  });

  it('concatenates multiple files with headers and reports progress', async () => {
    const provider = stubProvider(() => 'img text');
    const files: IngestFile[] = [
      { filename: 'a.txt', mimeType: 'text/plain', bytes: enc('alpha') },
      { filename: 'b.png', mimeType: 'image/png', bytes: enc('pixels') },
    ];
    const progress: number[] = [];
    const res = await ingestFiles(files, {
      modelProvider: provider,
      onProgress: ({ pct }) => {
        progress.push(pct);
      },
    });

    expect(res.files).toHaveLength(2);
    expect(res.text).toContain('# a.txt');
    expect(res.text).toContain('alpha');
    expect(res.text).toContain('# b.png');
    expect(res.text).toContain('img text');
    expect(res.text).toContain('---');
    expect(progress.length).toBe(2);
  });
});
