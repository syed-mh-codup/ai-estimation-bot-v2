'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Render a generated document, and let somebody take it away. AEH-239.
 *
 * ## The sandbox is the security boundary
 *
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`. That pair together
 * would defeat the sandbox entirely — a frame with both can reach into the
 * parent's origin — so the two attributes must never appear side by side here.
 * With scripts alone the document runs in an opaque origin: its tabs work, its
 * click-to-trace works, and it can touch none of this app's cookies, storage or
 * DOM.
 *
 * The document also carries its own `default-src 'none'` CSP, written by the
 * assembler. Two independent layers, because this HTML was written by a model
 * and is about to be handed to a client.
 *
 * ## Why the download is built here rather than linked
 *
 * The content is already in the page, so a Blob and an object URL hand over the
 * exact bytes being displayed with no second request and nothing to get out of
 * step. Revoked immediately after the click — an object URL pins its Blob in
 * memory for the lifetime of the document otherwise, and this Blob is ~100KB.
 */
export function ArtifactFrame({
  html,
  filename,
}: {
  html: string;
  filename: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [expanded, setExpanded] = useState(false);

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={download} data-testid="download-artifact">
          Download
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setExpanded((v) => !v)}
          data-testid="expand-artifact"
        >
          {expanded ? 'Shrink' : 'Full height'}
        </Button>
        <p className="text-[12px] text-ink-4">
          Runs isolated — it cannot reach this app or the network.
        </p>
      </div>

      <iframe
        ref={frameRef}
        // NEVER add allow-same-origin: with allow-scripts it lifts the sandbox.
        sandbox="allow-scripts"
        // Lets a diagram go full screen. AEH-329.
        //
        // A different mechanism from `sandbox`, not a loosening of it:
        // Permissions Policy delegates one capability, while the sandbox is
        // what keeps the document in an opaque origin. Measured with the
        // artifact's own CSP inside this exact sandbox — `allow-scripts` alone
        // reports `document.fullscreenEnabled === false`, adding this reports
        // true, and the origin stays opaque in both. So the line above still
        // holds and this does not weaken it.
        //
        // Without it the diagram's own control falls back to filling the frame
        // rather than the screen, which is why this is an improvement and not a
        // dependency.
        allow="fullscreen"
        srcDoc={html}
        title="Generated artifact"
        data-testid="artifact-frame"
        className="w-full rounded-lg border border-line bg-surface"
        style={{ height: expanded ? '85vh' : '600px' }}
      />
    </div>
  );
}
