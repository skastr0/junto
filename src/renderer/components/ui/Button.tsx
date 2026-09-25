import type { ComponentPropsWithRef, ReactNode } from "react";

/**
 * The house button. One component for every clickable action — surface
 * chrome, cards, dialogs, wizards. Variants:
 *  - chrome  — default bordered control on raised panels
 *  - primary — the one amber action per surface (never two)
 *  - subtle  — quiet text action (cancel, advanced toggles)
 *  - danger  — destructive, crimson, used sparingly
 * Sizes: xs = card chips, sm = chrome/dense toolbars, md = dialog actions.
 */
export type ButtonVariant = "chrome" | "primary" | "subtle" | "danger";
export type ButtonSize = "xs" | "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  chrome:
    "border border-white/10 bg-white/[0.04] text-ink hover:bg-white/10",
  primary:
    "border border-amber/35 bg-amber/[0.18] text-amber-hi font-semibold hover:bg-amber/[0.26]",
  subtle:
    "border border-transparent bg-transparent text-dim hover:text-ink hover:bg-white/[0.06]",
  danger:
    "border border-crimson/40 bg-crimson/10 text-crimson hover:bg-crimson/[0.18]",
};

const SIZE: Record<ButtonSize, string> = {
  xs: "gap-1 rounded px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em]",
  sm: "gap-1.5 rounded-[5px] px-2 py-1 text-[9px] uppercase tracking-[0.12em]",
  md: "gap-1.5 rounded-md px-3 py-1.5 text-[12px]",
};

export function Button({
  variant = "chrome",
  size = "sm",
  className,
  children,
  type = "button",
  ...rest
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly className?: string;
  readonly children: ReactNode;
} & ComponentPropsWithRef<"button">) {
  return (
    <button
      type={type}
      className={[
        "inline-flex items-center justify-center transition-colors select-none",
        "disabled:opacity-40 disabled:pointer-events-none",
        VARIANT[variant],
        SIZE[size],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
