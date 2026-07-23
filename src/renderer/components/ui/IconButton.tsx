import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Square icon-only button (lucide glyph). The single affordance for
 * close/edit/delete/open glyphs on cards, toolbars, and panel headers.
 * Always pair with aria-label + title — the icon is never self-describing.
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
  readonly size?: "sm" | "md";
  readonly className?: string;
  readonly children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const tones = {
    default: "text-steel hover:bg-white/10 hover:text-ink",
    danger: "text-steel hover:bg-white/10 hover:text-crimson",
    accent: "text-cyan/70 hover:bg-white/10 hover:text-cyan",
  } as const;
  const sizes = {
    sm: "size-6",
    md: "size-7",
  } as const;
  return (
    <button
      type={type}
      className={[
        "grid place-items-center rounded transition-colors select-none",
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
