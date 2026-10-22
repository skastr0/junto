import { useEffect, useState } from "react";
import { KIND_ICON_KINDS, type KindIconKind } from "@shared/kind-icon";
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

const STATES: ReadonlyArray<{ readonly state: KindState; readonly head: string }> = [
  { state: "idle", head: "Quiet" },
  { state: "working", head: "Working" },
  { state: "needs", head: "Needs you" },
  { state: "blocked", head: "Blocked or failed" },
  { state: "done", head: "Done" },
];

type Row = {
  readonly kind: KindIconKind;
  readonly word: string;
  readonly name: string;
  readonly ledger?: KindLedger;
  readonly line: Record<KindState, string>;
};

const same = (line: string): Record<KindState, string> => ({ idle: line, off: line, working: line, needs: line, blocked: line, done: line });

const ROWS: ReadonlyArray<Row> = [
  { kind: "task", word: "Tasks", name: "Ship 0.10", ledger: { kind: "task", done: 6, open: 3, needs: 1, blocked: 0, backlog: 4 },
    line: { idle: "14 tasks, none open", off: "board is off", working: "14 tasks, 3 open", needs: "14 tasks, 1 needs you", blocked: "14 tasks, 1 blocked", done: "14 tasks, all done" } },
  { kind: "artifacts", word: "Artifacts", name: "Shelf", ledger: { kind: "artifacts", count: 9 },
    line: { idle: "9 artifacts", off: "9 artifacts", working: "9 artifacts, one being written", needs: "a comment awaits you", blocked: "9 artifacts, sync stopped", done: "9 artifacts, new version" } },
  { kind: "automations", word: "Automations", name: "Nightly", ledger: { kind: "automations", on: 2, off: 1, failed: 0 },
    line: { idle: "2 on, 1 off", off: "all off", working: "firing nightly review", needs: "a run asks you", blocked: "last run failed", done: "ran clean at 09:00" } },
  { kind: "page", word: "Page", name: "docs.example.com", ledger: { kind: "page", tabs: 3 },
    line: { idle: "no session", off: "closed", working: "page, builder drives", needs: "paused, over to you", blocked: "load failed", done: "session live" } },
  { kind: "terminal", word: "Terminal", name: "dev server",
    line: { idle: "idle shell", off: "stopped", working: "bun test", needs: "prompt waits", blocked: "exited 1", done: "finished" } },
  { kind: "git", word: "Git", name: "junto", ledger: { kind: "git" },
    line: { idle: "main, clean", off: "no repo", working: "pushing main", needs: "conflict, needs you", blocked: "push rejected", done: "main, up to date" } },
  { kind: "file", word: "File", name: "plan.pdf",
    line: { idle: "docs/plan.pdf", off: "retired", working: "being edited", needs: "changed on disk", blocked: "file is missing", done: "saved" } },
  { kind: "link", word: "Link", name: "RFC 42",
    line: { idle: "example.com", off: "retired", working: "checking the link", needs: "asks you to sign in", blocked: "link is dead", done: "link is good" } },
  { kind: "note", word: "Note", name: "Ship Friday",
    line: { idle: "Freeze copy Wed.", off: "Freeze copy Wed.", working: "a seat is editing", needs: "mentions you", blocked: "edit conflict", done: "saved" } },
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
          {STATES.map((s) => (
            <span key={s.state} className="text-label text-dim">{s.head}</span>
          ))}
          {ROWS.map((row) => (
            <div key={row.kind} className="contents">
              <span className="text-body font-semibold text-ink">{row.word}</span>
              {STATES.map((s) => (
                <div key={s.state} className={["junto-node react-flow__node", selected ? "selected" : ""].join(" ")} style={{ position: "relative", width: 216, height: 56 }}>
                  <KindSeat kind={row.kind} name={row.name} line={row.line[s.state] ?? same("")[s.state]} state={s.state} ledger={row.ledger} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
