import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeBesideRect } from "../../lib/menu-placement";
import { openSettingsAt } from "../../lib/settings-state";
import { chooseSettingsMachine } from "../../lib/settings-machine";
import { nextCacheStatusChange, seatCacheStatusCopy, type SeatCacheFace } from "./seat-cache-status";

/** A timer's longest delay; a later change is waited for again when this one fires. */
const MAX_DELAY_MS = 2_147_483_647;
/** How long the pointer rests on the line before its card shows. */
const OPEN_DELAY_MS = 350;
/** Grace to cross from the line into its card. */
const CLOSE_DELAY_MS = 150;
const SIDES = ["below", "above", "right", "left"] as const;

/**
 * The still seat's cache status line, under its name, and its hover card.
 * The one drawing of it: the look the operator picks replaces this
 * component, and the words come from seat-cache-status.ts. Drawn as words
 * only for now (look A): the seat's state and how long it has been still,
 * then "cache expired" past its window. Nothing moves; the words change on
 * the minute and at the window's end.
 */
export function SeatCacheStatus({
  words,
  face,
  host,
}: {
  /** The seat's state line ("resting", "not running"). */
  readonly words: string;
  readonly face: SeatCacheFace;
  /** The seat's machine, for the settings link. */
  readonly host?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const changeAt = nextCacheStatusChange(face.window, now);
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(changeAt - Date.now(), 0), MAX_DELAY_MS));
    return () => clearTimeout(timer);
  }, [changeAt]);

  const lineRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const later = (next: boolean, ms: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (next) setNow(Date.now());
      setOpen(next);
    }, ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = seatCacheStatusCopy(words, face, now);
  return (
    <span
      ref={lineRef}
      className="flex min-w-0"
      data-testid="seat-cache-status"
      data-cache={copy.expired ? "expired" : "warm"}
      onPointerEnter={() => later(true, OPEN_DELAY_MS)}
      onPointerLeave={() => later(false, CLOSE_DELAY_MS)}
    >
      <span className="min-w-0 truncate text-dim">{copy.expired ? `${copy.line},` : copy.line}</span>
      {copy.expired ? <span className="shrink-0 pl-[0.5ch] text-amber-fg">cache expired</span> : null}
      {open && lineRef.current ? (
        <SeatCacheCard
          anchor={lineRef.current}
          rows={copy.rows}
          notes={copy.notes}
          onEnter={() => clearTimeout(timer.current)}
          onLeave={() => later(false, CLOSE_DELAY_MS)}
          onSettings={() => {
            if (host !== undefined) chooseSettingsMachine(host);
            openSettingsAt({ section: "offboard", setting: "Cache window" });
            setOpen(false);
          }}
        />
      ) : null}
    </span>
  );
}

function SeatCacheCard({
  anchor,
  rows,
  notes,
  onEnter,
  onLeave,
  onSettings,
}: {
  readonly anchor: HTMLElement;
  readonly rows: ReturnType<typeof seatCacheStatusCopy>["rows"];
  readonly notes: ReadonlyArray<string>;
  readonly onEnter: () => void;
  readonly onLeave: () => void;
  readonly onSettings: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ readonly x: number; readonly y: number } | null>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    setPosition(placeBesideRect(
      anchor.getBoundingClientRect(),
      { width: card.offsetWidth, height: card.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      SIDES,
      "center",
    ));
  }, [anchor]);
  // Portaled out of the camera's plane, so it reads at screen size at any zoom.
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      data-layer="popover"
      data-testid="seat-cache-card"
      className="junto-popover font-mono text-label"
      style={{ width: 360, left: position?.x ?? 0, top: position?.y ?? 0, visibility: position ? "visible" : "hidden" }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      // The canvas under it never takes this press as a drag or a select.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-faint">{row.key}</dt>
            <dd className="min-w-0 text-dim">{row.value}</dd>
          </div>
        ))}
      </dl>
      {notes.map((note) => (
        <p key={note} className="m-0 text-dim">{note}</p>
      ))}
      <button type="button" className="self-start text-cyan-fg hover:underline" onClick={onSettings}>
        Settings, Machine, Cache window
      </button>
    </div>,
    document.body,
  );
}
