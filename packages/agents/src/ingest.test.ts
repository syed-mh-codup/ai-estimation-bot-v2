import { describe, it, expect, vi } from 'vitest';
import type { ChatOptions, IModelProvider } from '@repo/providers';
import { createUsageRecorder } from './usage-recorder';
import { ingestFile, ingestFiles, type IngestFile } from './ingest';

const enc = (s: string) => new TextEncoder().encode(s);

/** Minimal stub: chat() returns a canned string; embed unused. */
function stubProvider(chat: (o: ChatOptions) => Promise<string> | string): IModelProvider {
  return {
    chat: vi.fn(async (o: ChatOptions) => ({
      text: await chat(o),
      model: 'stub/model',
      usage: null,
    })),
    chatStream: vi.fn(),
    embed: vi.fn(async () => ({ vectors: [[0]], model: 'stub/model', usage: null })),
  };
}

function recorder() {
  return createUsageRecorder({
    db: { modelUsage: { create: vi.fn() } } as never,
    estimateId: null,
  });
}

describe('ingest: text + unknown (no LLM)', () => {
  it('decodes a .txt file directly without calling the model', async () => {
    const provider = stubProvider(() => 'SHOULD NOT BE CALLED');
    const file: IngestFile = { filename: 'sow.txt', mimeType: 'text/plain', bytes: enc('hello world') };
    const out = await ingestFile(file, { modelProvider: provider, recorder: recorder() });
    expect(out.kind).toBe('text');
    expect(out.text).toBe('hello world');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('treats an unknown extension as UTF-8 text', async () => {
    const file: IngestFile = { filename: 'notes.xyz', mimeType: '', bytes: enc('raw notes') };
    const out = await ingestFile(file, { modelProvider: stubProvider(() => ''), recorder: recorder() });
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
    const out = await ingestFile(file, { modelProvider: provider, recorder: recorder(), visionModel: 'vis/model' });

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
    const out = await ingestFile(file, { modelProvider: provider, recorder: recorder() });

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
    const out = await ingestFile(file, { modelProvider: provider, recorder: recorder() });

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
    const out = await ingestFile(file, { modelProvider: provider, recorder: recorder() });
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
      recorder: recorder(),
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

  it('assembles the SOW in the order it was given the files', async () => {
    // The contract the whole ordering chain rests on. The uploader arranges the
    // documents, the form appends them in that arrangement, the route stores
    // the index as `UploadedFile.order`, and the ingest reads them back by it —
    // and all of that is pointless if this function does not concatenate in the
    // order of its argument. Asserted by POSITION rather than with `toContain`,
    // which the test above uses and which passes for any order at all.
    const provider = stubProvider(() => 'unused');
    const named = (n: string): IngestFile => ({
      filename: `${n}.txt`,
      mimeType: 'text/plain',
      bytes: enc(`body of ${n}`),
    });

    const forward = await ingestFiles([named('one'), named('two'), named('three')], {
      modelProvider: provider,
      recorder: recorder(),
    });
    expect(forward.text.indexOf('# one.txt')).toBeLessThan(forward.text.indexOf('# two.txt'));
    expect(forward.text.indexOf('# two.txt')).toBeLessThan(forward.text.indexOf('# three.txt'));

    // Reversed input, reversed SOW. Same three files, so nothing but the
    // argument order can account for the difference.
    const reversed = await ingestFiles([named('three'), named('two'), named('one')], {
      modelProvider: provider,
      recorder: recorder(),
    });
    expect(reversed.text.indexOf('# three.txt')).toBeLessThan(reversed.text.indexOf('# two.txt'));
    expect(reversed.text.indexOf('# two.txt')).toBeLessThan(reversed.text.indexOf('# one.txt'));
    expect(reversed.text).not.toEqual(forward.text);
  });

  it('keeps a file that produced no text out of the SOW without shifting the rest', async () => {
    // An empty file is dropped from the text (it has nothing to contribute) but
    // must not reorder what remains.
    const provider = stubProvider(() => 'unused');
    const files: IngestFile[] = [
      { filename: 'first.txt', mimeType: 'text/plain', bytes: enc('alpha') },
      { filename: 'blank.txt', mimeType: 'text/plain', bytes: enc('   ') },
      { filename: 'last.txt', mimeType: 'text/plain', bytes: enc('omega') },
    ];
    const res = await ingestFiles(files, { modelProvider: provider, recorder: recorder() });

    expect(res.text).not.toContain('# blank.txt');
    expect(res.text.indexOf('# first.txt')).toBeLessThan(res.text.indexOf('# last.txt'));
    // Still reported as a file that was read, so the count in the UI is honest.
    expect(res.files).toHaveLength(3);
  });
});
