import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Square icon-only button (lucide glyph). The single affordance for
 * close/edit/delete/open glyphs on cards, toolbars, and panel headers.
 * Always pair with aria-label + title — the icon is never self-describing.
 * Glyph size follows the button: 12px or less in xs, 15px or so in sm and md.
 */
export function IconButton({
  tone = "default",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: {
  readonly tone?: "default" | "danger" | "accent";
  /** xs is 16px, for a control that sits inside one line of dense text (a diff row). */
  readonly size?: "xs" | "sm" | "md";
  readonly className?: string;
  readonly children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const tones = {
    default: "text-steel hover:bg-ink/10 hover:text-ink",
    danger: "text-steel hover:bg-ink/10 hover:text-crimson",
    accent: "text-cyan/70 hover:bg-ink/10 hover:text-cyan",
  } as const;
  const sizes = {
    xs: "size-4",
    sm: "size-6",
    md: "size-7",
  } as const;
  return (
    <button
      type={type}
      className={[
        "grid place-items-center rounded outline-none transition-colors select-none",
        // Inset, so it reads on a 16px control and survives a clipping parent.
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan/60",
        "disabled:opacity-40 disabled:pointer-events-none",
        tones[tone],
        sizes[size],
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
