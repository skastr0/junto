/**
 * Animation census probe (measurement only, never a gate): during a seat-event
 * storm, sample document.getAnimations() and tally which CSS animations and
 * transitions are actually running, by name and target class. Names the
 * main-thread tick source the all-off arm removes.
 *
 *   PROBE_RATE=10 PROBE_SECONDS=8 scripts/run-e2e.sh e2e/scenarios/zz-anim-census.spec.ts
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ElectronApplication } from "playwright-core";
import { SeatStateMachine } from "../../src/core/term/agent-state";
import { OPERATOR_DISPLAY, type NestedCanvasFixture } from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const CHANNEL = "junto:agent-seat-state-changed";
const RATE = Number(process.env["PROBE_RATE"] ?? 10);
const SECONDS = Number(process.env["PROBE_SECONDS"] ?? 8);

const send = (app: ElectronApplication, events: ReadonlyArray<unknown>) =>
  app.evaluate(({ BrowserWindow }, { channel, events }) => {
    for (const w of BrowserWindow.getAllWindows()) for (const e of events) w.webContents.send(channel, e);
  }, { channel: CHANNEL, events });

test("anim census: which animations tick during a seat-event storm", async () => {
  test.setTimeout(900_000);
  const parsed = JSON.parse(await readFile(join(process.cwd(), "e2e/scenarios/zz-idle-probe.factory.json"), "utf8")) as Omit<NestedCanvasFixture, "signals"> & { signalRows: ReturnType<NestedCanvasFixture["signals"]> };
  const fixture: NestedCanvasFixture = { ...parsed, signals: () => parsed.signalRows };
  const seats = (parsed.model.nodes as ReadonlyArray<{ kind: string; bindingId?: string; harness?: string }>)
    .filter((n) => n.kind === "agent" && n.bindingId)
    .map((n) => ({ bindingId: n.bindingId!, harness: n.harness ?? "codex" }));
  const machine = new SeatStateMachine({ now: () => Date.now() });
  for (const s of seats) machine.bind(s.bindingId, { harness: s.harness, epoch: "probe" });
  const working = new Map<string, boolean>();
  let pick = 7;
  const next = () => {
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
    await send(app, seats.map((s) => { working.set(s.bindingId, true); return machine.force(s.bindingId, "working", "probe:working"); }));
    await page.waitForTimeout(4_000);

    // Sample getAnimations() during the storm; tally name x target class.
    await page.evaluate(() => {
      (window as any).__animTally = new Map<string, number>();
      (window as any).__animSampler = setInterval(() => {
        for (const a of document.getAnimations()) {
          // getAnimations() keeps finished fill-forwards animations in the
          // list forever; only running/pending ones tick on the main thread.
          if (a.playState !== "running" && a.playState !== "pending") continue;
          const t = (a as any).effect?.target as Element | null;
          if (!t) continue;
          const cs = (a as any).animationName ?? (a as any).transitionProperty ?? "?";
          const cls = String((t as HTMLElement).className ?? "").split(" ")[0] || t.tagName;
          const key = `${a.constructor.name}|${cs}|${cls}`;
          (window as any).__animTally.set(key, ((window as any).__animTally.get(key) ?? 0) + 1);
        }
      }, 200);
    });

    const gap = 1000 / RATE;
    const t0 = Date.now();
    for (let i = 0; i < RATE * SECONDS; i++) {
      await send(app, [next()]);
      const wait = t0 + (i + 1) * gap - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
    }
    await page.waitForTimeout(500);

    const tally = await page.evaluate(() => {
      clearInterval((window as any).__animSampler);
      return [...((window as any).__animTally as Map<string, number>).entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40);
    });
    console.log(`ANIM-CENSUS ${JSON.stringify(tally)}`);
  } finally {
    await junto.close();
  }
});
