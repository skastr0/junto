import type { ComponentPropsWithRef, ReactNode } from "react";

/**
 * The house button. One component for every clickable action — surface
 * chrome, cards, dialogs, wizards. Variants:
 *  - chrome  — default bordered control on raised panels
 *  - primary — the one amber action per surface (never two)
 *  - subtle  — quiet text action (cancel, advanced toggles)
 *  - danger  — destructive, crimson, used sparingly
 *  - armed   — waiting for the operator's next input (recording a
 *              shortcut): the field focus look, on a button. Swap to it
 *              with the variant; never add a border colour by className,
 *              where it would fight the variant's own.
 * Sizes: xs = card chips, sm = chrome/dense toolbars, md = dialog actions.
 */
export type ButtonVariant = "chrome" | "primary" | "subtle" | "danger" | "armed";
export type ButtonSize = "xs" | "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  chrome:
    "border border-stroke bg-ink/[0.04] text-ink hover:bg-ink/10",
  primary:
    "border border-amber/35 bg-amber/[0.18] text-amber-hi font-semibold hover:bg-amber/[0.26]",
  subtle:
    "border border-transparent bg-transparent text-dim hover:text-ink hover:bg-ink/[0.06]",
  danger:
    "border border-crimson/40 bg-crimson/10 text-crimson hover:bg-crimson/[0.18]",
  armed:
    "border border-cyan/60 bg-ink/[0.04] text-ink shadow-[0_0_0_3px_var(--color-focus-ring)]",
};

// Every button can be hit across at least 24px of height, the WCAG 2.2 AA
// target minimum, whatever its drawn size: an invisible area centred on it.
// The button is positioned for that, so do not place one with absolute or
// fixed from a caller's className; wrap it instead.
const HIT_24 =
  "relative before:absolute before:inset-x-0 before:top-1/2 before:h-6 before:-translate-y-1/2 before:content-['']";

const SIZE: Record<ButtonSize, string> = {
  xs: "gap-1 rounded px-1.5 py-0.5 text-caption uppercase tracking-label",
  sm: "gap-1.5 rounded-md px-2 py-1 text-caption uppercase tracking-eyebrow",
  md: "gap-1.5 rounded-md px-3 py-1.5 text-body-lg",
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
        HIT_24,
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
