import { AnimatePresence, motion } from "motion/react";
import { use$ } from "@legendapp/state/react";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { state$ } from "../lib/state";
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

  return (
    <AnimatePresence>
      {open && digest ? (
        <motion.aside
          key="digest"
          role="dialog"
          aria-label="Canvas digest"
          aria-modal="true"
          data-testid="canvas-digest"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="absolute right-0 top-0 z-50 flex h-full w-[440px] max-w-[90vw] flex-col border-l border-stroke bg-ground"
        >
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
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
