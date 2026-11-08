/**
 * Seat-event probe (measurement only, never a gate): what the window pays
 * for live seats reporting, on the operator's factory board shape. Seat
 * state events built by the core SeatStateMachine (real statuses, so the
 * window decodes what it would) are sent from main on the live channel at a
 * fixed rate, half of them a seat re-sending the state it is in, half a
 * seat turning between working and idle. Per variant: renderer main-thread
 * busy, its tasks over 16 and 50 ms, main frames and frames presented.
 *
 *   PROBE_RATE=10 scripts/run-e2e.sh e2e/scenarios/zz-seat-events-probe.spec.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { SeatStateMachine } from "../../src/core/term/agent-state";
import type { SeatFact } from "../../src/core/term/agent-state/seat-state-machine";
import type { SeatSignal, SignalSource } from "../../src/shared/harness-domain";
import { OPERATOR_DISPLAY, type NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const CHANNEL = "junto:agent-seat-state-changed";
const RATE = Number(process.env["PROBE_RATE"] ?? 10);
const SECONDS = Number(process.env["PROBE_SECONDS"] ?? 8);
const REPS = Number(process.env["PROBE_REPS"] ?? 3);

type Ev = { name?: string; ph?: string; pid?: number; tid?: number; ts?: number; dur?: number; args?: Record<string, unknown> };

const send = (app: ElectronApplication, events: ReadonlyArray<unknown>) =>
  app.evaluate(({ BrowserWindow }, { channel, events }) => {
    for (const w of BrowserWindow.getAllWindows()) for (const e of events) w.webContents.send(channel, e);
  }, { channel: CHANNEL, events });

/** Renderer main thread: busy ms/s and top-level tasks by length; frames. */
const read = (events: Ev[], seconds: number) => {
  const threads = new Map<string, string>();
  const procs = new Map<number, string>();
  for (const e of events) {
    if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, String(e.args?.["name"]));
    if (e.ph === "M" && e.name === "process_name") procs.set(e.pid!, String(e.args?.["name"]));
  }
  const main = events
    .filter((e) => e.ph === "X" && typeof e.dur === "number" && threads.get(`${e.pid}:${e.tid}`) === "CrRendererMain" && /renderer/i.test(procs.get(e.pid!) ?? "renderer"))
    .sort((a, b) => a.ts! - b.ts!);
  let end = 0;
  let busy = 0;
  const tops: number[] = [];
  for (const e of main) {
    if (e.ts! < end) continue;
    busy += e.dur! / 1000;
    tops.push(e.dur! / 1000);
    end = e.ts! + e.dur!;
  }
  const count = (n: string) => events.filter((e) => e.name === n && e.ph !== "E").length;
  tops.sort((a, b) => b - a);
  return {
    mainBusyMsPerS: Math.round(busy / seconds),
    tasksOver16PerS: +(tops.filter((d) => d > 16).length / seconds).toFixed(2),
    tasksOver50: tops.filter((d) => d > 50).length,
    worstTaskMs: Math.round(tops[0] ?? 0),
    mainFramesPerS: +(count("ProxyMain::BeginMainFrame") / seconds).toFixed(1),
    presentedPerS: Math.round(count("Display::DrawAndSwap") / seconds),
  };
};

const trace = async (app: ElectronApplication, path: string, during: () => Promise<void>) => {
  await app.evaluate(async ({ contentTracing }) => {
    await contentTracing.startRecording({ included_categories: ["toplevel", "devtools.timeline", "viz", "cc", "benchmark", ...(process.env["PROBE_JS"] === "1" ? ["disabled-by-default-v8.cpu_profiler", "v8.execute", "disabled-by-default-devtools.timeline.stack"] : []), ...(process.env["PROBE_CATS"] ?? "").split(",").filter(Boolean)] });
  });
  await during();
  await app.evaluate(async ({ contentTracing }, out) => contentTracing.stopRecording(out), path);
  const raw = JSON.parse(await readFile(path, "utf8")) as { traceEvents?: Ev[] } | Ev[];
  return Array.isArray(raw) ? raw : (raw.traceEvents ?? []);
};

test("seat-event probe: what live seats reporting cost the window", async () => {
  test.setTimeout(900_000);
  const parsed = JSON.parse(await readFile(join(process.cwd(), "e2e/scenarios/zz-idle-probe.factory.json"), "utf8")) as Omit<NestedCanvasFixture, "signals"> & { signalRows: ReturnType<NestedCanvasFixture["signals"]> };
  const fixture: NestedCanvasFixture = { ...parsed, signals: () => parsed.signalRows };
  const seats = (parsed.model.nodes as ReadonlyArray<{ kind: string; id?: string; bindingId?: string; harness?: string }>)
    .filter((n) => n.kind === "agent" && n.bindingId)
    .map((n) => ({ nodeId: n.id!, bindingId: n.bindingId!, harness: n.harness ?? "codex" }));
  const machine = new SeatStateMachine({ now: () => Date.now() });
  for (const s of seats) machine.bind(s.bindingId, { harness: s.harness, epoch: "probe" });
  const working = new Map<string, boolean>();
  let pick = 7;
  const next = () => {
    // Deterministic walk over the seats: half re-send, half turn.
    pick = (pick * 1103515245 + 12345) % 2147483648;
    const seat = seats[pick % seats.length]!;
    const turn = (pick >> 8) % 2 === 0;
    const now = working.get(seat.bindingId) ?? true;
    const state = turn ? !now : now;
    working.set(seat.bindingId, state);
    return machine.force(seat.bindingId, state ? "working" : "idle", state ? "probe:working" : "probe:idle");
  };

  const junto = await launchJunto({ ...OPERATOR_DISPLAY, nestedCanvas: { fixture, name: "factory" } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 120_000 });
    // Every seat working, as on the operator's board.
    await send(app, seats.map((s) => { working.set(s.bindingId, true); return machine.force(s.bindingId, "working", "probe:working"); }));
    // A measurement arm: a stylesheet laid over the page (PROBE_CSS), never shipped.
    if (process.env["PROBE_CSS"]) await page.addStyleTag({ content: process.env["PROBE_CSS"] });
    await page.waitForTimeout(4_000);
    const census = await page.evaluate(() => ({
      elements: document.querySelectorAll("*").length,
      parts: document.querySelectorAll(".junto-mark__part").length,
      animations: document.getAnimations().length,
    }));
    console.log(`SEAT-EVENTS-CENSUS ${JSON.stringify(census)}`);

    const storm = async (): Promise<void> => {
      const gap = 1000 / RATE;
      const t0 = Date.now();
      for (let i = 0; i < RATE * SECONDS; i++) {
        await send(app, [next()]);
        const wait = t0 + (i + 1) * gap - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
      }
    };
    const rest = async (): Promise<void> => page.waitForTimeout(SECONDS * 1000);
    const openFeed = async (page: Page, open: boolean): Promise<void> => {
      const isOpen = await page.locator('[data-testid="operator-feed-trigger"][aria-expanded="true"]').count() > 0;
      if (isOpen !== open) {
        if (open) await page.locator('[data-testid="operator-feed-trigger"]').click();
        else await page.keyboard.press("Escape");
      }
      await page.waitForTimeout(1_500);
    };

    const rows: Record<string, unknown>[] = [];
    for (let rep = 1; rep <= REPS; rep++) {
      const only = (process.env["PROBE_VARIANTS"] ?? "").split(",").filter(Boolean);
      for (const [variant, feed, run] of [["rest", false, rest], ["events", false, storm], ["events+feed", true, storm], ["rest+feed", true, rest]] as const) {
        if (only.length > 0 && !only.includes(variant)) continue;
        await openFeed(page, feed);
        const events = await trace(app, join(process.cwd(), `test-results/zz-seat-events-${variant}-${rep}.json`), run);
        const row = { variant, rep, rate: run === storm ? RATE : 0, ...read(events, SECONDS) };
        rows.push(row);
        console.log(`SEAT-EVENTS ${JSON.stringify(row)}`);
      }
    }
    await openFeed(page, false);
    console.log(`SEAT-EVENTS-ALL ${JSON.stringify(rows)}`);

    // Feed-check arm (PROBE_FEEDCHECK=1): storm attention and stopped
    // transitions through the real state machine and assert the rendered
    // feed rows carry exactly the attention/stopped items the probe's own
    // state says should be there — the signature gate must never drop one.
    if (process.env["PROBE_FEEDCHECK"] === "1") {
      const nodeOf = new Map(seats.map((s) => [s.bindingId, s.nodeId]));
      const attention = new Set<string>();
      const stopped = new Set<string>();
      const fact = (signal: SeatSignal, source: SignalSource = "screen"): SeatFact => ({
        signal,
        source,
        fidelity: source === "screen" ? "screen" : "native",
      });
      const LIMIT: SeatSignal = { _tag: "UsageLimitHit", scope: "weekly", message: "probe limit" };
      const TURN: SeatSignal = { _tag: "TurnStarted" };
      const rowSets = async (): Promise<{ attention: Set<string>; stopped: Set<string>; all: Set<string> }> => {
        const all = new Set(await page.locator('[data-testid="operator-feed-card"]').evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-item-id") ?? ""),
        ));
        return {
          all,
          attention: new Set([...all].filter((id) => id.startsWith("attention:"))),
          stopped: new Set([...all].filter((id) => id.startsWith("stopped:"))),
        };
      };
      const assertRows = async (step: number): Promise<void> => {
        // The feed re-renders a beat behind the wire; poll to convergence so
        // a slow frame is not read as a dropped row, then hold the verdict.
        let last = { attention: new Set<string>(), stopped: new Set<string>(), all: new Set<string>() };
        let missing: string[] = [];
        let extra: string[] = [];
        for (let attempt = 0; attempt < 25; attempt++) {
          last = await rowSets();
          const wantAttention = new Set([...attention].map((b) => `attention:${nodeOf.get(b)}`));
          const wantStopped = new Set([...stopped].map((b) => `stopped:${nodeOf.get(b)}`));
          missing = [...wantAttention, ...wantStopped].filter((id) => !last.all.has(id));
          extra = [...last.attention, ...last.stopped].filter((id) => !wantAttention.has(id) && !wantStopped.has(id));
          if (missing.length === 0 && extra.length === 0) break;
          await page.waitForTimeout(100);
        }
        console.log(`FEEDCHECK step=${step} cards=${last.all.size} attention=${last.attention.size} stopped=${last.stopped.size} missing=${missing.length} extra=${extra.length}`);
        expect(missing, `feed missed rows at step ${step}: ${missing.join(",")}`).toEqual([]);
        expect(extra, `feed grew rows nobody asked for at step ${step}: ${extra.join(",")}`).toEqual([]);
      };
      await openFeed(page, true);
      pick = 11;
      const gap = 1000 / RATE;
      const t0 = Date.now();
      for (let i = 0; i < RATE * SECONDS; i++) {
        pick = (pick * 1103515245 + 12345) % 2147483648;
        const seat = seats[pick % seats.length]!;
        const b = seat.bindingId;
        const mode = (pick >> 8) % 4;
        if (mode === 0) {
          attention.add(b);
          stopped.delete(b);
          await send(app, [machine.force(b, "attention", "probe:ask", "high")]);
        } else if (mode === 1) {
          // A hard stop projects the seat to attention as well: the feed
          // carries both its ask row and its stopped row until recovery.
          attention.add(b);
          stopped.add(b);
          await send(app, [machine.force(b, "working", "probe:limit", "high", fact(LIMIT))]);
        } else if (mode === 2) {
          attention.delete(b);
          stopped.delete(b);
          await send(app, [machine.force(b, "working", "probe:ok", "high", fact(TURN))]);
        } else {
          attention.delete(b);
          stopped.delete(b);
          const now = working.get(b) ?? true;
          working.set(b, !now);
          await send(app, [machine.force(b, now ? "idle" : "working", now ? "probe:idle" : "probe:working")]);
        }
        if (i % 10 === 9) await assertRows(i);
        const wait = t0 + (i + 1) * gap - Date.now();
        if (wait > 0) await page.waitForTimeout(wait);
      }
      await assertRows(RATE * SECONDS);
      await openFeed(page, false);
    }
  } finally {
    await junto.close();
  }
});
