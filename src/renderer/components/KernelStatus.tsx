import { use$ } from "@legendapp/state/react";
import { kernel$ } from "../lib/kernel-view";
import { HUE, INK, withAlpha } from "../lib/theme";

// The durable-intent surfaces the kernel refuses to hide. `fault` — persisted
// arming could not be loaded, so armed regions were NOT resumed — is the LOUD
// the invariant demands: a persistent crimson strip across the top of the
// canvas. `orphaned` — armed `canvas::region` keys whose canvas/region is gone
// from every hydrated document — is preserved intent, listed quietly with an
// explicit disarm affordance so it can only leave by an operator act.

function FaultBanner({ fault }: { readonly fault: string }) {
  return (
    <div
      role="alert"
      className="kernel-fault absolute left-0 right-0 top-0 z-[60] flex items-baseline gap-3 px-4 py-2"
      style={{ background: withAlpha(HUE.crimson, 0.16), borderBottom: `1px solid ${withAlpha(HUE.crimson, 0.5)}`, backdropFilter: "blur(10px)" }}
    >
      <span className="shrink-0 text-[8px] font-semibold uppercase tracking-[0.18em]" style={{ color: HUE.crimson }}>kernel · arming fault</span>
      <span className="text-[10px] leading-snug" style={{ color: INK }}>{fault}</span>
    </div>
  );
}

// Orphan list relocated into the RTS bar notification stack (RtsBottomBar).
// Fault banner stays top — it is LOUD by invariant.

export function KernelStatus() {
  const fault = use$(kernel$.fault);
  return <>{fault ? <FaultBanner fault={fault} /> : null}</>;
}
