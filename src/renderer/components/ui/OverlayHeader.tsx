import type { HTMLAttributes, ReactNode } from "react";
import { Eyebrow } from "./Eyebrow";

/**
 * Overlay header — the one chrome header for every work-surface panel
 * (terminal, herdr, browser, detail readers). Structure:
 *   eyebrow (context hints) / title / status line ----- actions
 * Replaces the cloned herdr-modal-header / browser-modal-header blocks and
 * gives surfaces like the native terminal the same face.
 */
export function OverlayHeader({
  eyebrow,
  title,
  status,
  actions,
  className,
  ...rest
}: {
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  return (
    <header
      className={[
        "flex shrink-0 items-center justify-between gap-3 border-b border-stroke bg-raise-2 px-3.5 py-2.5",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <div className="min-w-0">
        {eyebrow ? <Eyebrow tone="steel">{eyebrow}</Eyebrow> : null}
        <div className="truncate font-mono text-[14px] font-semibold text-ink">{title}</div>
        {status ? <div className="mt-0.5 truncate text-[11px] text-dim">{status}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}
