import type { ReactNode } from "react";

/**
 * Eyebrow — the tiny uppercase tracked label above a title or section.
 * Tone rules: steel for panel/overlay headers, cyan for document/detail
 * chrome, amber for call-to-attention, faint for card-internal labels.
 */
export function Eyebrow({
  tone = "steel",
  size = "sm",
  className,
  children,
}: {
  readonly tone?: "steel" | "cyan" | "amber" | "faint";
  readonly size?: "xs" | "sm";
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const tones = {
    steel: "text-steel",
    cyan: "text-cyan",
    amber: "text-amber",
    faint: "text-faint",
  } as const;
  const sizes = {
    xs: "text-[8px] tracking-[0.16em]",
    sm: "text-[10px] tracking-[0.14em]",
  } as const;
  return (
    <div
      className={["uppercase select-none", tones[tone], sizes[size], className ?? ""]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
