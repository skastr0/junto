import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import type { ServiceHealth } from "@shared/contracts";
import { HUE, withAlpha } from "../lib/theme";

const statusHex: Record<ServiceHealth, string> = {
  ok: "#5FB98E",
  warning: HUE.amber,
  error: HUE.crimson,
  unknown: "#8a8378",
};

const statusIcon = {
  ok: CheckCircle2,
  warning: CircleAlert,
  error: XCircle,
  unknown: CircleHelp,
} satisfies Record<ServiceHealth, typeof CheckCircle2>;

export function StatusPill({ status }: { readonly status: ServiceHealth }) {
  const Icon = statusIcon[status];
  const hex = statusHex[status];

  return (
    <span
      className="inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium uppercase tracking-[0.08em]"
      style={{
        color: hex,
        borderColor: withAlpha(hex, 0.4),
        background: withAlpha(hex, 0.1),
      }}
    >
      <Icon size={14} aria-hidden />
      {status}
    </span>
  );
}
