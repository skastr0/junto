import { use$ } from "@legendapp/state/react";
import { herdr$ } from "../../lib/herdr-state";

export function HerdrToast() {
  const toast = use$(herdr$.toast);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-[100] -translate-x-1/2 rounded-md border border-white/10 bg-[#1a1714] px-3 py-2 text-xs text-ink shadow-lg">
      {toast}
    </div>
  );
}
