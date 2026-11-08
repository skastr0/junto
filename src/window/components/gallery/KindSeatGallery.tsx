import { useEffect, useState } from "react";
import { KIND_ICON_KINDS, type KindIconKind } from "@shared/kind-icon";
import { SeatUrgency } from "@shared/wire/urgency";
import type { KindLedger, KindState } from "../../lib/kind-band";
import { ensureMarkAtlas } from "../../lib/activity-atlas";
import { startSurfaceMotionGate } from "../../lib/surface-motion";
import { KindSeat } from "../nodes/KindSeat";
import { Button, Eyebrow } from "../ui";

/**
 * Dev gallery for the kind seats: every non-seat kind in every state, animated, in the app's own
 * theme. Route: `#/gallery/kinds`. Each node sits in the seat's shell (a `.junto-node` 216 by 56) so
 * the shell recipe in kind-seat.css shows too; a row's Select shows the selected wash.
 */

const S = SeatUrgency.group;

/** The columns, in the order each row's `lines` are written. */
const COLUMNS: ReadonlyArray<{ readonly state: KindState; readonly head: string }> = [
  { state: S.resting, head: "Quiet" },
  { state: S.working, head: "Working" },
  { state: S.waiting, head: "Needs you" },
  { state: S.blocked, head: "Blocked or failed" },
  { state: S.done, head: "Done" },
];

type Row = {
  readonly kind: KindIconKind;
  readonly word: string;
  readonly name: string;
  readonly ledger?: KindLedger;
  /** One line per column. */
  readonly lines: readonly [string, string, string, string, string];
};

const ROWS: ReadonlyArray<Row> = [
  { kind: "task", word: "Tasks", name: "Ship 0.10", ledger: { kind: "task", finished: 6, open: 3, asks: 1, stuck: 0, backlog: 4 },
    lines: ["14 tasks, none open", "14 tasks, 3 open", "14 tasks, 1 needs you", "14 tasks, 1 blocked", "14 tasks, all done"] },
  { kind: "artifacts", word: "Artifacts", name: "Shelf", ledger: { kind: "artifacts", count: 9 },
    lines: ["9 artifacts", "9 artifacts, one being written", "a comment awaits you", "9 artifacts, sync stopped", "9 artifacts, new version"] },
  { kind: "automations", word: "Automations", name: "Nightly", ledger: { kind: "automations", on: 2, off: 1, failed: 0 },
    lines: ["2 on, 1 off", "firing nightly review", "a run asks you", "last run failed", "ran clean at 09:00"] },
  { kind: "page", word: "Page", name: "docs.example.com", ledger: { kind: "page", tabs: 3 },
    lines: ["no session", "page, builder drives", "paused, over to you", "load failed", "session live"] },
  { kind: "terminal", word: "Terminal", name: "dev server",
    lines: ["idle shell", "bun test", "prompt waits", "exited 1", "finished"] },
  { kind: "git", word: "Git", name: "junto", ledger: { kind: "git" },
    lines: ["main, clean", "pushing main", "conflict, needs you", "push rejected", "main, up to date"] },
  { kind: "file", word: "File", name: "plan.pdf",
    lines: ["docs/plan.pdf", "being edited", "changed on disk", "file is missing", "saved"] },
  { kind: "link", word: "Link", name: "RFC 42",
    lines: ["example.com", "checking the link", "asks you to sign in", "link is dead", "link is good"] },
  { kind: "note", word: "Note", name: "Ship Friday",
    lines: ["Freeze copy Wed.", "a seat is editing", "mentions you", "edit conflict", "saved"] },
];

export function KindSeatGallery() {
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    ensureMarkAtlas("dark");
    ensureMarkAtlas("bright");
    return startSurfaceMotionGate();
  }, []);
  return (
    <main className="h-screen overflow-auto bg-ground text-ink">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-6 py-6">
        <header className="flex items-end justify-between gap-6">
          <div>
            <Eyebrow tone="amber">Junto dev gallery</Eyebrow>
            <h1 className="font-display text-hero uppercase leading-none tracking-soft text-ink">Kind seats</h1>
            <p className="mt-2 max-w-[780px] text-body text-dim">
              A non-seat kind in the seat's language: the seat's own ring around a plain icon, a ledger band outside the ring that says
              what the kind holds, the name and one line. The ring says the state; the band says the contents. One moving band part at
              most, on the ring's clock.
            </p>
          </div>
          <Button size="sm" variant={selected ? "primary" : "chrome"} onClick={() => setSelected((on) => !on)}>
            {selected ? "Unselect" : "Select all"}
          </Button>
        </header>
        <div className="grid items-center gap-x-4 gap-y-2" style={{ gridTemplateColumns: "110px repeat(5, 216px)" }}>
          <span />
          {COLUMNS.map((c) => (
            <span key={c.state} className="text-label text-dim">{c.head}</span>
          ))}
          {ROWS.map((row) => (
            <div key={row.kind} className="contents">
              <span className="text-body font-semibold text-ink">{row.word}</span>
              {COLUMNS.map((c, column) => (
                <div key={c.state} className={["junto-node react-flow__node", selected ? "selected" : ""].join(" ")} style={{ position: "relative", width: 216, height: 56 }}>
                  <KindSeat kind={row.kind} name={row.name} line={row.lines[column] ?? ""} state={c.state} ledger={row.ledger} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
