import { use$ } from "@legendapp/state/react";
import { disarmOrphan, kernel$ } from "../lib/kernel-view";
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

function OrphanList({ keys }: { readonly keys: ReadonlyArray<string> }) {
  return (
    <div className="kernel-orphans field-readout pointer-events-auto absolute bottom-5 right-5 z-20 hidden w-[260px] flex-col gap-1.5 md:flex">
      <div className="field-readout__eyebrow" style={{ color: withAlpha(HUE.amber, 0.75) }}>
        <span className="field-readout__signal" style={{ background: HUE.amber, boxShadow: `0 0 10px ${withAlpha(HUE.amber, 0.6)}` }} />
        armed · orphaned
      </div>
      <div className="field-readout__rule" />
      {keys.map((key) => (
        <div key={key} className="flex items-center justify-between gap-2">
          <span className="truncate text-[9px] uppercase tracking-[0.12em]" style={{ color: withAlpha(HUE.amber, 0.7) }} title={key}>{key}</span>
          <button
            type="button"
            aria-label={`Disarm orphaned ${key}`}
            title="disarm — canvas or region is gone"
            className="shrink-0 rounded-sm border px-1.5 py-0.5 text-[8px] uppercase tracking-[0.14em] transition hover:bg-white/5"
            style={{ color: withAlpha(HUE.amber, 0.9), borderColor: withAlpha(HUE.amber, 0.4), background: "rgba(255,255,255,.02)" }}
            onClick={() => void disarmOrphan(key)}
          >disarm</button>
        </div>
      ))}
    </div>
  );
}

export function KernelStatus() {
  const fault = use$(kernel$.fault);
  const orphaned = use$(kernel$.orphaned) as ReadonlyArray<string> | undefined;
  const orphans = orphaned ?? [];
  return (
    <>
      {fault ? <FaultBanner fault={fault} /> : null}
      {orphans.length > 0 ? <OrphanList keys={orphans} /> : null}
    </>
  );
}
