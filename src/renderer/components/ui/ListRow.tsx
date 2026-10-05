import type { ComponentPropsWithRef, ReactNode } from "react";

/**
 * ListRow: one clickable row of a dense live list (the agent modal's
 * connected agents). A leading mark, a title, a trailing meta, and one quiet
 * line of detail under the title.
 *
 * The height is fixed, so the list never jumps when a detail arrives or
 * clears: 44px with a detail line, 28px when `dense`. The row carries no
 * colour of its own; colour belongs to the leading mark, and to a meta word
 * the caller marks crimson because it needs the operator.
 *
 * Size is chosen by `dense`, never by a caller's class: two size classes on
 * one element resolve by stylesheet order.
 */
export function ListRow({
  leading,
  title,
  meta,
  detail,
  dense = false,
  selected = false,
  className,
  type = "button",
  ...rest
}: {
  /** A ring, portrait, dot or glyph. Vertically centred, never resized here. */
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  /** Right aligned beside the title: a state and its age. Digits do not shift. */
  readonly meta?: ReactNode;
  /** One line under the title, truncated. A string also becomes its hover text. */
  readonly detail?: ReactNode;
  /** One line, 28px: for rows with no detail to show. */
  readonly dense?: boolean;
  readonly selected?: boolean;
  readonly className?: string;
} & Omit<ComponentPropsWithRef<"button">, "title">) {
  return (
    <button
      type={type}
      aria-current={selected ? "true" : undefined}
      className={[
        "flex w-full shrink-0 items-center gap-2 rounded-sm px-2.5 text-left outline-none transition-colors select-none",
        "hover:bg-overlay-1 aria-[current=true]:bg-overlay-2",
        "focus-visible:shadow-[0_0_0_3px_var(--color-focus-ring)]",
        "disabled:pointer-events-none disabled:opacity-40",
        dense ? "h-7" : "h-11",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-body leading-compact font-medium text-ink">{title}</span>
          {meta ? (
            <span className="shrink-0 text-label leading-compact text-dim tabular-nums">{meta}</span>
          ) : null}
        </span>
        {!dense && detail ? (
          <span className="truncate text-label leading-dense text-dim" title={typeof detail === "string" ? detail : undefined}>
            {detail}
          </span>
        ) : null}
      </span>
    </button>
  );
}
