import type { ComponentPropsWithRef, ReactNode } from "react";

/**
 * ListRow: one clickable line of a dense list (a plain connection in the
 * agent modal's rail, an item in a compact menu). A leading mark, a title,
 * and a trailing meta, on one 28px line.
 *
 * With an onClick the whole row is one button, so it holds no interactive
 * children: no menu, remove or switch inside it. A row that needs a trailing
 * control is a different shape, to be added here as a variant, not built
 * beside it. Without an onClick it is a plain line that only informs: no
 * hover, no focus stop, and never a disabled button, which would fade text
 * the operator is meant to read.
 *
 * The row chooses its own height and type and takes no className: place it
 * with the parent's layout. It carries no colour of its own; colour belongs
 * to the leading mark, and to a meta word the caller marks crimson because
 * it needs the operator.
 *
 * An agent is never a ListRow: an agent is rendered by the canvas's own
 * AgentSeat wherever it appears.
 */
export function ListRow({
  leading,
  title,
  meta,
  selected = false,
  type = "button",
  ...rest
}: {
  /** A glyph or a dot. Vertically centred, never resized here. */
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  /** Right aligned beside the title. Digits do not shift as they change. */
  readonly meta?: ReactNode;
  readonly selected?: boolean;
} & Omit<ComponentPropsWithRef<"button">, "title" | "className" | "aria-current" | "children">) {
  const row = "flex h-7 w-full shrink-0 items-center gap-2 rounded-sm px-2.5 text-left select-none";
  const content = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="min-w-0 flex-1 truncate text-body leading-compact font-medium text-ink">{title}</span>
      {meta ? <span className="shrink-0 text-label leading-compact text-dim tabular-nums">{meta}</span> : null}
    </>
  );
  if (!rest.onClick) {
    const { disabled: _disabled, ref, ...plain } = rest;
    return (
      <div
        {...(plain as ComponentPropsWithRef<"div">)}
        ref={ref as ComponentPropsWithRef<"div">["ref"]}
        aria-current={undefined}
        data-selected={selected ? "true" : undefined}
        className={`${row} data-[selected=true]:bg-overlay-2`}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type={type}
      {...rest}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      className={[
        row,
        "outline-none transition-colors",
        "hover:bg-overlay-1 data-[selected=true]:bg-overlay-2",
        // Inset, so a scrolling list that clips its edges still shows it.
        "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-cyan/60",
        "disabled:pointer-events-none disabled:opacity-40",
      ].join(" ")}
    >
      {content}
    </button>
  );
}
