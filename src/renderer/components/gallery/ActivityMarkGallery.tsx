import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { SquareTerminal } from "lucide-react";
import type { ThemeMode } from "@shared/theme";
import type { AgentSignal, AgentSignalKind } from "@shared/agent-signals";
import type { ThreadHealthTone, ThreadHealthValue } from "@shared/thread-health";
import {
  browserActivity,
  chatActivity,
  terminalActivity,
  timerActivity,
  toolActivity,
  watcherActivity,
  type ActivitySpec,
} from "../../lib/activity";
import { ensureMarkAtlas } from "../../lib/activity-atlas";
import { startSurfaceMotionGate } from "../../lib/surface-motion";
import { themeFor } from "../../lib/theme";
import { ActivityMark, ActivityMarkFromSpec } from "../ActivityMark";
import { AgentSeatView, type SeatHealth, type SeatSignal } from "../nodes/AgentSeat";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";
import { Button, Eyebrow } from "../ui";

/**
 * Dev gallery for the ring language: every seat and mark state, size and
 * theme, animated, for judging by eye. Route: `#/gallery/marks` (add
 * `?stress=320` for the fleet test, `&only` to show just the fleet). Specs
 * come from the real predicates in activity.ts, so the gallery shows exactly
 * what the canvas shows.
 */

type Row = { readonly name: string; readonly note: string; readonly spec: ActivitySpec };

const STATES: ReadonlyArray<Row> = [
  { name: "Working", note: "agent turn in flight", spec: terminalActivity({ seatState: "working" }) },
  {
    name: "Process",
    note: "unmanaged foreground command",
    spec: terminalActivity({ running: true, processName: "npm run dev" }),
  },
  { name: "Loading", note: "page attach, chat connect", spec: browserActivity({ state: "loading" }) },
  { name: "Needs input", note: "seat attention", spec: terminalActivity({ seatState: "attention" }) },
  {
    name: "Stalled",
    note: "turn stalled",
    spec: terminalActivity({ seatState: "attention", seatReason: "turn-stalled" }),
  },
  { name: "Due", note: "timer fired", spec: timerActivity({ nextFire: 0, now: 1 }) },
  { name: "Blocked", note: "graph stoppage", spec: terminalActivity({ seatState: "idle", graphBlocked: true }) },
  {
    name: "Failed to start",
    note: "CLI missing",
    spec: terminalActivity({ exitReason: "cli-missing", exitMessage: "claude is not installed" }),
  },
  { name: "Done", note: "waiting for review", spec: terminalActivity({ seatState: "idle", needsLook: true }) },
  { name: "Live session", note: "warm browser page", spec: browserActivity({ state: "ready" }) },
  { name: "Idle", note: "seated, nothing running", spec: terminalActivity({ seatState: "idle" }) },
  { name: "Unknown", note: "no event yet", spec: terminalActivity({ managedSeat: true, seatState: "unknown" }) },
  { name: "Gone", note: "process exited", spec: terminalActivity({ seatState: "gone" }) },
  { name: "Met", note: "watcher true", spec: watcherActivity("satisfied") },
  { name: "Error", note: "chat error", spec: chatActivity({ status: "error" }) },
  { name: "Tool done", note: "transcript row", spec: toolActivity("completed") },
];

const pick = (name: string): ActivitySpec =>
  STATES.find((row) => row.name === name)?.spec ?? STATES[0]!.spec;

const reading = (
  health: ThreadHealthTone,
  value: ThreadHealthValue,
  line: string,
  healthStale = false,
): SeatHealth => ({ health, value, healthStale, line, label: `AI reads: ${line}` });

const declared = (kind: AgentSignalKind, text: string, openCount = 1): SeatSignal => ({
  openCount,
  worst: {
    signalId: `${kind}-demo`,
    canvasName: "gallery",
    nodeId: "gallery",
    kind,
    text,
    createdAt: 0,
    state: "open",
  } satisfies AgentSignal,
});

const NO_SIGNAL: SeatSignal = { openCount: 0 };
const NO_HEALTH: SeatHealth = {};

type Seat = {
  readonly id: string;
  readonly name: string;
  readonly harness?: string;
  readonly spec: ActivitySpec;
  readonly health?: SeatHealth;
  readonly signal?: SeatSignal;
  readonly context?: string;
  readonly caption: string;
};

const SEATS: ReadonlyArray<Seat> = [
  { id: "seat-planner", name: "planner", harness: "claude", spec: pick("Working"), health: reading("good", "going_well", "going well"), caption: "working, going well" },
  { id: "seat-flaky", name: "flaky-tests", harness: "codex", spec: pick("Working"), health: reading("trouble", "thrashing", "thrashing"), caption: "working, AI reads thrashing: the ring snakes" },
  { id: "seat-migrate", name: "migrations", harness: "claude", spec: pick("Working"), health: reading("trouble", "stuck", "stuck"), caption: "working, AI reads stuck: the lap runs backwards" },
  { id: "seat-review", name: "reviewer", harness: "claude", spec: pick("Needs input"), caption: "needs input: a ring goes out, twice, then waits" },
  { id: "seat-deploy", name: "deploy", harness: "codex", spec: pick("Working"), signal: declared("blocked", "needs the prod DB password", 2), caption: "declared blocked: crimson glow, flag, line" },
  { id: "seat-schema", name: "schema", harness: "claude", spec: pick("Idle"), signal: declared("escalate", "two specs disagree on ids"), caption: "declared escalate" },
  { id: "seat-docs", name: "docs", harness: "grok", spec: pick("Idle"), signal: declared("feedback", "draft ready, worth a look"), caption: "declared feedback" },
  { id: "seat-done", name: "refactor", harness: "claude", spec: pick("Done"), health: reading("good", "exceeding", "exceeding expectations"), caption: "done: sweeps closed and rests, halo and spark" },
  { id: "seat-quiet", name: "notes", harness: "claude", spec: pick("Idle"), caption: "idle" },
  { id: "seat-lost", name: "scraper", harness: "codex", spec: pick("Idle"), health: reading("trouble", "confused", "confused"), caption: "idle, AI reads confused: the ring fractures" },
  { id: "seat-wait", name: "triage", harness: "claude", spec: pick("Idle"), health: reading("waiting", "waiting_on_operator", "wants your input"), caption: "AI reads waiting: a soft amber glow" },
  { id: "seat-old", name: "archive", harness: "claude", spec: pick("Working"), health: reading("good", "going_well", "going well, 9m ago", true), caption: "stale reading: the halo fades" },
  { id: "seat-halt", name: "ingest", harness: "codex", spec: pick("Blocked"), caption: "graph blocked: heavy ring, double beat" },
  { id: "seat-fail", name: "bootstrap", harness: "grok", spec: pick("Failed to start"), context: "grok is not installed", caption: "failed to start" },
  { id: "seat-gone", name: "old-worker", harness: "claude", spec: pick("Gone"), caption: "gone" },
];

/** Token overrides so a panel renders in its own theme regardless of the page. */
const themeVars = (mode: ThemeMode): CSSProperties => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(themeFor(mode))) out[`--color-${name}`] = value;
  return out as CSSProperties;
};

function Section({ title, hint, children }: { readonly title: string; readonly hint: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-stroke pt-4">
      <div className="flex items-baseline justify-between gap-4">
        <Eyebrow tone="steel">{title}</Eyebrow>
        <span className="text-[11px] text-faint">{hint}</span>
      </div>
      {children}
    </section>
  );
}

/** A seat in the canvas shell's agent shape (factory-grammar.css), at the default size. */
function SeatShell({ seat, caption = true }: { readonly seat: Seat; readonly caption?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="junto-node"
        data-node-kind="agent"
        style={{
          width: 240,
          height: 72,
          border: "1px solid var(--color-stroke)",
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--color-raise) 94%, transparent), color-mix(in oklab, var(--color-ground) 96%, transparent))",
          boxShadow: "0 10px 28px var(--color-shadow-2)",
        }}
      >
        <AgentSeatView
          identity={seat.id}
          activity={seat.spec}
          harness={seat.harness}
          context={seat.context}
          health={seat.health ?? NO_HEALTH}
          signal={seat.signal ?? NO_SIGNAL}
          onSignalOpen={() => undefined}
          title={<div className="truncate font-mono text-[14px] font-semibold leading-snug text-ink">{seat.name}</div>}
        />
      </div>
      {caption ? <span className="pl-2 text-[10px] text-faint">{seat.caption}</span> : null}
    </div>
  );
}

function StatesTable({ replay }: { readonly replay: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_60px_60px_30px_24px_30px] items-center gap-x-3 gap-y-1.5">
      <span className="text-[10px] text-faint">state</span>
      <span className="text-[10px] text-faint">seat</span>
      <span className="text-[10px] text-faint">x3</span>
      <span className="text-[10px] text-faint">node</span>
      <span className="text-[10px] text-faint">inline</span>
      <span className="text-[10px] text-faint">frozen</span>
      {STATES.map((row) => (
        <StateRow key={`${row.name}:${String(replay)}`} row={row} />
      ))}
    </div>
  );
}

function StateRow({ row }: { readonly row: Row }) {
  return (
    <>
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px] text-ink">{row.name}</div>
        <div className="truncate text-[10px] text-dim">
          {row.note}, {row.spec.mode} {row.spec.tone}
        </div>
      </div>
      <span className="grid place-items-center">
        <ActivityMarkFromSpec spec={row.spec} size="seat">
          <span className="block size-9 rounded-full bg-overlay-2" />
        </ActivityMarkFromSpec>
      </span>
      <span className="grid place-items-center">
        <ActivityMarkFromSpec spec={row.spec} className="junto-mark--preview" />
      </span>
      <span className="grid place-items-center">
        <ActivityMarkFromSpec spec={row.spec} />
      </span>
      <span className="grid place-items-center">
        <ActivityMarkFromSpec spec={row.spec} size="inline" />
      </span>
      <span className="grid place-items-center">
        <ActivityMark {...row.spec} active={false} />
      </span>
    </>
  );
}

function CardRow() {
  const cards: ReadonlyArray<readonly [string, string, ActivitySpec]> = [
    ["dev-server", "npm run dev, pid 4312", pick("Process")],
    ["docs page", "attaching", pick("Loading")],
    ["nightly", "due", pick("Due")],
    ["shell", "seated", pick("Idle")],
  ];
  return (
    <div className="grid grid-cols-2 gap-3">
      {cards.map(([title, subtitle, spec]) => (
        <div key={title} className="rounded-[10px] border border-stroke bg-raise px-3.5 py-3">
          <ExecutionCardHeader
            decal={
              <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
                <SquareTerminal size={15} />
              </div>
            }
            title={title}
            subtitle={subtitle}
            activity={spec}
          />
        </div>
      ))}
    </div>
  );
}

function Panel({ mode, replay }: { readonly mode: ThemeMode; readonly replay: number }) {
  return (
    <div
      data-mark-theme={mode}
      style={{ ...themeVars(mode), background: themeFor(mode).ground, colorScheme: mode === "dark" ? "dark" : "light" }}
      className="flex min-w-0 flex-1 flex-col gap-5 rounded-[6px] border border-stroke p-5 text-ink"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-display text-[22px] uppercase tracking-[0.04em] text-ink">{mode}</span>
        <span className="text-[11px] text-faint">everything animates live</span>
      </div>
      <Section title="Seats" hint="portrait in its ring, name, one line">
        <div className="grid grid-cols-2 gap-x-4 gap-y-3" key={`seats:${String(replay)}`}>
          {SEATS.map((seat) => (
            <SeatShell key={seat.id} seat={seat} />
          ))}
        </div>
      </Section>
      <Section title="Ring language" hint="every state, every size">
        <StatesTable replay={replay} />
      </Section>
      <Section title="Other cards" hint="standalone ring with a hub, upper right">
        <CardRow />
      </Section>
    </div>
  );
}

const STRESS_SEATS: ReadonlyArray<Seat> = SEATS.slice(0, 8);

/**
 * Fleet test: N real seats (portrait + ring + line), mostly looping, in a
 * scroll box taller than the window so part of the fleet is offscreen and
 * must not tick.
 */
function Stress({ count, bare }: { readonly count: number; readonly bare: boolean }) {
  const [visible, setVisible] = useState(0);
  const [frame, setFrame] = useState<string | undefined>();
  useEffect(() => {
    const id = window.setInterval(() => {
      setVisible(document.querySelectorAll(".junto-mark[data-mark-visible]").length);
      setFrame(document.documentElement.dataset.markFrame);
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  // Memoized so the readout's twice-a-second update never re-renders the
  // fleet: the probe measures the marks, not the gallery.
  const grid = useMemo(() => {
    const seats = Array.from({ length: count }, (_, i) => ({
      ...STRESS_SEATS[i % STRESS_SEATS.length]!,
      id: `fleet-${String(i)}`,
    }));
    return bare ? (
      <div className="grid grid-cols-[repeat(auto-fill,20px)] gap-2" data-testid="mark-stress-grid">
        {seats.map((seat) => (
          <ActivityMarkFromSpec key={seat.id} spec={seat.spec} />
        ))}
      </div>
    ) : (
      <div className="grid grid-cols-[repeat(auto-fill,240px)] gap-2" data-testid="mark-stress-grid">
        {seats.map((seat) => (
          <SeatShell key={seat.id} seat={seat} caption={false} />
        ))}
      </div>
    );
  }, [count, bare]);
  return (
    <section data-mark-theme="dark" className="flex flex-col gap-3 rounded-[6px] border border-stroke bg-ground p-5">
      <div className="flex items-baseline justify-between">
        <Eyebrow tone="amber">
          Fleet stress, {count} {bare ? "bare marks" : "seats"}
        </Eyebrow>
        <span className="font-mono text-[11px] text-dim" data-testid="mark-stress-readout">
          visible looping {visible}, clock frame {frame ?? "idle"}
        </span>
      </div>
      {grid}
    </section>
  );
}

const parseStress = (hash: string): number => {
  const match = /[?&]stress=(\d+)/.exec(hash);
  return match ? Math.min(2000, Number(match[1])) : 0;
};

/** `&only` renders just the fleet: the perf probe measures seats, not the gallery. */
const parseOnly = (hash: string): boolean => /[?&]only\b/.test(hash);
/** `&bare` makes the fleet bare 20px marks, comparable with the old grid mark. */
const parseBare = (hash: string): boolean => /[?&]bare\b/.test(hash);

export function ActivityMarkGallery() {
  const [replay, setReplay] = useState(0);
  const [stress, setStress] = useState(() => parseStress(window.location.hash));
  const only = parseOnly(window.location.hash);
  useEffect(() => {
    ensureMarkAtlas("dark");
    ensureMarkAtlas("bright");
    return startSurfaceMotionGate();
  }, []);
  return (
    <main className="h-screen overflow-auto bg-ground text-ink">
      <style>{`.junto-mark.junto-mark--preview{--mark-u:60px}`}</style>
      <div className="mx-auto flex max-w-[1480px] flex-col gap-5 px-6 py-6">
        <header className="flex items-end justify-between gap-6">
          <div>
            <Eyebrow tone="amber">Junto dev gallery</Eyebrow>
            <h1 className="font-display text-[34px] uppercase leading-none tracking-[0.03em] text-ink">
              Seats and rings
            </h1>
            <p className="mt-2 max-w-[780px] text-[12px] text-dim">
              An agent is a seat: its portrait held by a living ring, the name, one line. The ring circles while it
              works, runs backwards when stuck, snakes when thrashing, sends a ring out when it wants you, beats
              heavy when blocked, and sweeps closed and rests when done. The band outside says who waits on whom.
              One shared 90 ms clock, only on screen.
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setReplay((n) => n + 1)}>
              Replay done
            </Button>
            <Button size="sm" variant={stress ? "primary" : "chrome"} onClick={() => setStress((n) => (n ? 0 : 320))}>
              {stress ? "Hide fleet" : "Fleet of 320"}
            </Button>
          </div>
        </header>
        {stress ? <Stress count={stress} bare={parseBare(window.location.hash)} /> : null}
        {only ? null : (
          <div className="flex gap-5">
            <Panel mode="dark" replay={replay} />
            <Panel mode="bright" replay={replay} />
          </div>
        )}
      </div>
    </main>
  );
}
