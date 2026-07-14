import mammoth from 'mammoth';
import type { ContentPart, IModelProvider } from '@repo/providers';

/**
 * Document ingestion: turn arbitrary client material (PDF, DOCX, images, plain
 * text) into clean text suitable for the SOW. Content *inside* images — scans,
 * screenshots, diagrams, tables-as-pictures — is read via a vision-capable model,
 * and PDFs are parsed through OpenRouter's `file-parser` plugin (OCR-capable).
 */

// Verified against live OpenRouter: OpenAI models read images but REFUSE the
// file-parser's parsed PDF text, while Anthropic models read parsed PDFs but
// don't accept image input. So images and PDFs use different models.
const DEFAULT_VISION_MODEL = 'openai/gpt-4o-mini'; // images (vision)
const DEFAULT_PDF_MODEL = 'anthropic/claude-haiku-4.5'; // PDFs via file-parser

const IMAGE_PROMPT =
  'Transcribe ALL content from this image into clean text/markdown. Include any text inside ' +
  'the image, plus a faithful description of diagrams, screenshots, tables, and charts (render ' +
  'tables as markdown tables). Preserve structure and order. Do not summarise or add commentary.';

const PDF_PROMPT =
  'Transcribe ALL content from this document into clean text/markdown. Include text inside ' +
  'images, diagrams, tables, and screenshots; render tables as markdown. Preserve headings and ' +
  'order. Do not summarise — output the full content.';

export type IngestFile = {
  filename: string;
  /** MIME type from the upload; falls back to extension sniffing. */
  mimeType: string;
  bytes: Uint8Array;
};

export type IngestDeps = {
  modelProvider: IModelProvider;
  /** Vision-capable model for images. */
  visionModel?: string;
  /** Model that accepts the file-parser's parsed PDF text (must be Anthropic-class). */
  pdfModel?: string;
  /** PDF parser engine; tried first, then falls back to plain text extraction. */
  pdfEngine?: 'mistral-ocr' | 'pdf-text' | 'native';
  /** Per-file progress (filename + 0–100 across the batch). */
  onProgress?: (p: { stage: string; pct: number }) => void | Promise<void>;
};

export type IngestedFile = {
  filename: string;
  kind: 'pdf' | 'image' | 'docx' | 'text' | 'unknown';
  text: string;
  chars: number;
  error?: string;
};

export type IngestResult = { text: string; files: IngestedFile[] };

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

function detectKind(file: IngestFile): IngestedFile['kind'] {
  const mt = file.mimeType.toLowerCase();
  const name = file.filename.toLowerCase();
  if (mt === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (IMAGE_MIME.test(mt) || /\.(png|jpe?g|webp|gif)$/.test(name)) return 'image';
  if (
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) {
    return 'docx';
  }
  if (mt.startsWith('text/') || /\.(txt|md|markdown|csv|json)$/.test(name)) return 'text';
  return 'unknown';
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function parseImage(file: IngestFile, deps: IngestDeps): Promise<string> {
  const mime = IMAGE_MIME.test(file.mimeType) ? file.mimeType : 'image/png';
  const url = `data:${mime};base64,${toBase64(file.bytes)}`;
  const content: ContentPart[] = [
    { type: 'text', text: IMAGE_PROMPT },
    { type: 'image_url', image_url: { url } },
  ];
  return deps.modelProvider.chat({
    model: deps.visionModel ?? DEFAULT_VISION_MODEL,
    messages: [{ role: 'user', content }],
    maxTokens: 4000,
  });
}

async function parsePdf(file: IngestFile, deps: IngestDeps): Promise<string> {
  const url = `data:application/pdf;base64,${toBase64(file.bytes)}`;
  const content: ContentPart[] = [
    { type: 'text', text: PDF_PROMPT },
    { type: 'file', file: { filename: file.filename, file_data: url } },
  ];
  // Try the OCR-capable engine first (reads images/scans), then fall back to
  // plain text extraction if that engine is unavailable for this account.
  const engines = [...new Set([deps.pdfEngine ?? 'mistral-ocr', 'pdf-text'])];
  let lastErr: unknown;
  for (const engine of engines) {
    try {
      return await deps.modelProvider.chat({
        model: deps.pdfModel ?? DEFAULT_PDF_MODEL,
        messages: [{ role: 'user', content }],
        plugins: [{ id: 'file-parser', pdf: { engine } }],
        maxTokens: 8000,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('PDF parse failed');
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function parseDocx(file: IngestFile, deps: IngestDeps): Promise<string> {
  const buffer = Buffer.from(file.bytes);
  // Collect embedded images so we can vision-transcribe them too (the user's
  // BRDs may carry diagrams/screenshots inside the .docx).
  const images: Array<{ contentType: string; b64: string }> = [];
  const { value: html } = await mammoth.convertToHtml(
    { buffer },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const b64 = await image.read('base64');
        images.push({ contentType: image.contentType, b64 });
        return { src: '' };
      }),
    },
  );

  let text = htmlToText(html);

  for (let i = 0; i < images.length; i += 1) {
    const img = images[i]!;
    try {
      const transcribed = await parseImage(
        { filename: `${file.filename}#img${i + 1}`, mimeType: img.contentType, bytes: Uint8Array.from(Buffer.from(img.b64, 'base64')) },
        deps,
      );
      text += `\n\n[Embedded image ${i + 1}]\n${transcribed}`;
    } catch {
      /* skip an unreadable embedded image rather than fail the whole file */
    }
  }
  return text;
}

function parseText(file: IngestFile): string {
  return new TextDecoder('utf-8').decode(file.bytes).trim();
}

/** Ingest one file into text. Never throws — failures are captured per file. */
export async function ingestFile(file: IngestFile, deps: IngestDeps): Promise<IngestedFile> {
  const kind = detectKind(file);
  try {
    let text = '';
    if (kind === 'pdf') text = await parsePdf(file, deps);
    else if (kind === 'image') text = await parseImage(file, deps);
    else if (kind === 'docx') text = await parseDocx(file, deps);
    else if (kind === 'text') text = parseText(file);
    else {
      // Best-effort: treat unknown as UTF-8 text.
      text = parseText(file);
    }
    return { filename: file.filename, kind, text, chars: text.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { filename: file.filename, kind, text: '', chars: 0, error: msg };
  }
}

/**
 * Ingest a batch of files sequentially (keeps token spikes/rate-limits sane) and
 * concatenate into a single SOW-ready document with per-file headers.
 */
export async function ingestFiles(files: IngestFile[], deps: IngestDeps): Promise<IngestResult> {
  const out: IngestedFile[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i]!;
    if (deps.onProgress) {
      await deps.onProgress({
        stage: `Reading ${f.filename} (${i + 1}/${files.length})`,
        pct: files.length > 0 ? Math.round((100 * i) / files.length) : 0,
      });
    }
    out.push(await ingestFile(f, deps));
  }

  const text = out
    .filter((f) => f.text.trim().length > 0)
    .map((f) => `# ${f.filename}\n\n${f.text}`)
    .join('\n\n---\n\n');

  return { text, files: out };
}
