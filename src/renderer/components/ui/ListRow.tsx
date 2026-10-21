import type { ComponentPropsWithRef, ReactNode } from "react";
import { FOCUS_RING_INSET } from "./focus";

/**
 * ListRow: one clickable line of a dense list (a plain connection in the
 * agent modal's rail, an item in a compact menu). A leading mark, a title,
 * and a trailing meta, on one 28px line.
 *
 * With an onClick the whole row is one button, so it holds no interactive
 * children: no menu, remove or switch inside it. A row that needs a trailing
 * control is a different shape, to be added here as a variant, not built
 * beside it. Without an onClick it is a plain line that only informs: no
 * hover, no focus stop, its text can be selected and copied, and it is never
 * a disabled button, which would fade text the operator is meant to read.
 * onClick alone decides which one you get: a row made interactive only by
 * another handler (onPointerDown, onDoubleClick, onKeyDown) is still a plain
 * div with no focus stop. Give it an onClick.
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
  pending = false,
  type = "button",
  ...rest
}: {
  /** A glyph or a dot. Vertically centred, never resized here. */
  readonly leading?: ReactNode;
  readonly title: ReactNode;
  /** Right aligned beside the title. Digits do not shift as they change. Past half the line it truncates. */
  readonly meta?: ReactNode;
  readonly selected?: boolean;
  /** A queued command the editing machine has not ruled yet (02): a dashed edge, read aloud as "queued". */
  readonly pending?: boolean;
} & Omit<ComponentPropsWithRef<"button">, "title" | "className" | "aria-current" | "children">) {
  const row =
    "flex h-7 w-full shrink-0 items-center gap-2 rounded-sm px-2.5 text-left data-[pending=true]:outline data-[pending=true]:outline-1 data-[pending=true]:-outline-offset-1 data-[pending=true]:outline-dashed data-[pending=true]:outline-stroke-hi";
  const content = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      {/* The title keeps at least half the line: a long meta truncates there, never the title down to two letters. */}
      <span className="min-w-[50%] flex-1 truncate text-body leading-compact font-medium text-ink">
        {title}
        {pending ? <span className="sr-only">, queued</span> : null}
      </span>
      {meta ? <span className="min-w-0 truncate text-label leading-compact text-dim tabular-nums">{meta}</span> : null}
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
        data-pending={pending ? "true" : undefined}
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
      data-pending={pending ? "true" : undefined}
      className={[
        row,
        "outline-none transition-colors select-none",
        "hover:bg-overlay-1 data-[selected=true]:bg-overlay-2",
        // Inset, so a scrolling list that clips its edges still shows it.
        FOCUS_RING_INSET,
        "disabled:pointer-events-none disabled:opacity-40",
      ].join(" ")}
    >
      {content}
    </button>
  );
}
