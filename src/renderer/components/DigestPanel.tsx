import { use$ } from "@legendapp/state/react";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { state$ } from "../lib/state";
import { FocusSurface } from "./FocusSurface";
import { Button, IconButton, OverlayHeader } from "./ui";

function useDigestCopy(digest: string | undefined) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (!digest) return;
    const write = navigator.clipboard?.writeText;
    if (write === undefined) {
      state$.error.set("Canvas digest copy is unavailable.");
      return;
    }
    void write
      .call(navigator.clipboard, digest)
      .then(() => setCopied(true))
      .catch(() => {
        state$.error.set("Canvas digest copy failed.");
      });
  };
  return { copied, copy };
}

export function DigestPanel() {
  const open = use$(state$.digestOpen);
  const digest = use$(state$.digest);
  const { copied, copy } = useDigestCopy(digest?.digest);
  const close = () => state$.digestOpen.set(false);

  if (!open || !digest) return null;
  return (
    <FocusSurface
      measure="document"
      height="immersive"
      label="Canvas digest"
      onClose={close}
      panelClassName="p-0! bg-ground!"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="canvas-digest">
          <OverlayHeader
            eyebrow="canvas digest"
            title="Canvas digest"
            status={digest.path}
            actions={
              <>
                <Button
                  variant="subtle"
                  size="sm"
                  className="digest-copy-button"
                  aria-label={copied ? "Digest copied" : "Copy digest"}
                  title={copied ? "Copied" : "Copy digest"}
                  onClick={copy}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "copied" : "copy"}
                </Button>
                <IconButton
                  aria-label="Close digest"
                  title="Close digest"
                  onClick={close}
                >
                  <X size={15} />
                </IconButton>
              </>
            }
          />
          <pre
            className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed text-ink"
            data-testid="canvas-digest-body"
          >
            {digest.digest}
          </pre>
      </div>
    </FocusSurface>
  );
}
