import { CheckCircle2, CircleAlert, CircleHelp, XCircle } from "lucide-react";
import type { ServiceHealth } from "@shared/contracts";

const statusClass: Record<ServiceHealth, string> = {
  ok: "border-emerald-400/40 bg-emerald-400/10 text-emerald-200",
  warning: "border-amber-300/40 bg-amber-300/10 text-amber-100",
  error: "border-rose-400/40 bg-rose-400/10 text-rose-100",
  unknown: "border-slate-400/30 bg-slate-400/10 text-slate-200",
};

const statusIcon = {
  ok: CheckCircle2,
  warning: CircleAlert,
  error: XCircle,
  unknown: CircleHelp,
} satisfies Record<ServiceHealth, typeof CheckCircle2>;

export function StatusPill({ status }: { readonly status: ServiceHealth }) {
  const Icon = statusIcon[status];

  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium uppercase tracking-normal ${statusClass[status]}`}
    >
      <Icon size={14} aria-hidden />
      {status}
    </span>
  );
}
