import { AnimatePresence, motion } from "motion/react";
import { use$ } from "@legendapp/state/react";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";
import { state$ } from "../lib/state";
import { HUE, INK } from "../lib/theme";

function useDigestCopy(digest: string | undefined) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (!digest || !navigator.clipboard) return;
    void navigator.clipboard.writeText(digest).then(() => setCopied(true)).catch(() => undefined);
  };
  return { copied, copy };
}

function DigestHeader({ path, copied, onCopy, onClose }: { readonly path: string; readonly copied: boolean; readonly onCopy: () => void; readonly onClose: () => void }) {
  return <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "rgba(237,230,218,.1)" }}>
    <div>
      <div className="text-[11px] uppercase tracking-[0.2em]" style={{ color: HUE.amber }}>canvas digest</div>
      <div className="mt-0.5 truncate text-[10px]" style={{ color: "#8a8378" }} title={path}>{path}</div>
    </div>
    <div className="flex items-center gap-1">
      <button className="digest-copy-button inline-flex items-center gap-1 rounded px-2 py-1 transition hover:bg-white/10" style={{ color: copied ? HUE.cyan : "#8a8378" }} aria-label={copied ? "Digest copied" : "Copy digest"} title={copied ? "Copied" : "Copy digest"} onClick={onCopy}>
        {copied ? <Check size={13} /> : <Copy size={13} />}<span>{copied ? "copied" : "copy"}</span>
      </button>
      <button className="grid size-7 place-items-center rounded transition hover:bg-white/10" style={{ color: "#8a8378" }} aria-label="Close digest" onClick={onClose}><X size={15} /></button>
    </div>
  </div>;
}

export function DigestPanel() {
  const open = use$(state$.digestOpen);
  const digest = use$(state$.digest);
  const { copied, copy } = useDigestCopy(digest?.digest);

  return <AnimatePresence>
    {open && digest ? <motion.aside key="digest" role="dialog" aria-label="Canvas digest" aria-modal="true" initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }} className="absolute right-0 top-0 z-50 flex h-full w-[440px] max-w-[90vw] flex-col border-l" style={{ borderColor: "rgba(237,230,218,0.12)", background: "rgba(12,11,10,0.97)" }}>
      <DigestHeader path={digest.path} copied={copied} onCopy={copy} onClose={() => state$.digestOpen.set(false)} />
      <pre className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-[11px] leading-relaxed" style={{ color: INK }}>{digest.digest}</pre>
    </motion.aside> : null}
  </AnimatePresence>;
}
