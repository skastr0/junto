import { AnimatePresence, motion } from "motion/react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import { state$ } from "../lib/state";
import { HUE, INK } from "../lib/theme";

export function DigestPanel() {
  const open = use$(state$.digestOpen);
  const digest = use$(state$.digest);

  return (
    <AnimatePresence>
      {open && digest ? (
        <motion.aside
          key="digest"
          initial={{ x: "100%" }}
          animate={{ x: 0 }}
          exit={{ x: "100%" }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="absolute right-0 top-0 z-50 flex h-full w-[440px] max-w-[90vw] flex-col border-l"
          style={{ borderColor: "rgba(237,230,218,0.12)", background: "rgba(12,11,10,0.97)" }}
        >
          <div
            className="flex items-center justify-between border-b px-4 py-3"
            style={{ borderColor: "rgba(237,230,218,0.1)" }}
          >
            <div>
              <div className="text-[11px] uppercase tracking-[0.2em]" style={{ color: HUE.amber }}>
                canvas digest
              </div>
              <div className="mt-0.5 truncate text-[10px]" style={{ color: "#8a8378" }} title={digest.path}>
                {digest.path}
              </div>
            </div>
            <button
              className="grid size-7 place-items-center rounded transition hover:bg-white/10"
              style={{ color: "#8a8378" }}
              onClick={() => state$.digestOpen.set(false)}
            >
              <X size={15} />
            </button>
          </div>
          <pre
            className="flex-1 overflow-auto whitespace-pre-wrap px-4 py-3 text-[11px] leading-relaxed"
            style={{ color: INK, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
          >
            {digest.digest}
          </pre>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
