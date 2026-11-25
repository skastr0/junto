/**
 * Scratch probe (untracked, measurement only): the unnamed blocked slice.
 *
 * The docked/grid open carries a ~263 ms EventDispatch(pointerout) that holds
 * only ~14% CPU and no child slices: it is blocked, not computing. This probe
 * runs the same open with the profiler OFF and only timestamps:
 *   - every pointer listener's own execution time, and what it did inside
 *     (a nested mark per listener call),
 *   - every long task the page reports,
 *   - React's own dispatch, by timing the document-level capture listeners.
 *
 * The instrumentation has to exist before the app binds its listeners, and a
 * reload of the Electron window aborts, so it rides in through the built page:
 * this file writes out/renderer/zz-probe.js and adds one script tag to
 * out/renderer/index.html the first time it is imported in a checkout.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { card, selectedIds } from "../harness/canvas";
import { modelFixture, modelSeat } from "../harness/model";
import { expect, test } from "../harness/launch";

const IDS = ["g1", "g2", "g3", "g4"] as const;
const OUT = `${homedir()}/grid-attrib`;

const INSTRUMENT = `(() => {
  const host = window;
  host.__pointer = [];
  host.__longtasks = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) host.__longtasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ entryTypes: ["longtask"] });
  } catch {}
  const watched = new Set(["pointerout", "pointerover", "pointermove", "pointerdown", "pointerup", "pointercancel", "click", "mousedown", "mouseup"]);
  const original = EventTarget.prototype.addEventListener;
  const patched = function addEventListener(type, listener, options) {
    if (!watched.has(type) || listener === null || listener === undefined) return original.call(this, type, listener, options);
    const wrap = (event) => {
      const at = performance.now();
      const tag = this instanceof Element ? this.tagName.toLowerCase() : this === document ? "document" : "window";
      const startMark = "junto-pointer:" + type + ":start";
      try { performance.mark(startMark); } catch {}
      try {
        if (typeof listener === "function") listener.call(this, event);
        else listener.handleEvent(event);
      } finally {
        const own = performance.now() - at;
        const name = typeof listener === "function" ? listener.name : "object";
        if (own >= 2) host.__pointer.push({ type, tag, own, at, handler: name });
      }
    };
    return original.call(this, type, wrap, options);
  };
  EventTarget.prototype.addEventListener = patched;
  // React listens at the root container in the capture phase; time the
  // document-level capture leg too, so a blocked dispatch names its event.
  for (const type of watched) {
    original.call(document, type, (event) => {
      const at = performance.now();
      queueMicrotask(() => {
        const own = performance.now() - at;
        if (own >= 4) host.__pointer.push({ type: "capture-" + type, tag: "document", own, at, handler: "capture" });
      });
    }, { capture: true, passive: true });
  }
})();`;

// Before the harness launches anything: the built page carries the probe.
const rendererDir = join(process.cwd(), "out", "renderer");
try {
  const html = readFileSync(join(rendererDir, "index.html"), "utf8");
  if (!html.includes("zz-probe.js")) {
    writeFileSync(join(rendererDir, "zz-probe.js"), INSTRUMENT);
    writeFileSync(
      join(rendererDir, "index.html"),
      html.replace("</head>", '<script src="./zz-probe.js"></script></head>'),
    );
    console.log("pointerout-block: instrumented out/renderer/index.html");
  }
} catch (error) {
  console.log(`pointerout-block: could not instrument the built page: ${String(error).slice(0, 120)}`);
}

test.use({
  juntoOptions: {
    seedModels: {
      grid: modelFixture(
        IDS.map((id, i) =>
          modelSeat({
            id,
            label: id,
            launch: { kind: "command", argv: ["/bin/sh", "-c", "exec sleep 3600"], cwd: "/tmp" },
            x: (i % 2) * 320,
            y: Math.floor(i / 2) * 180,
          }),
        ),
      ),
    },
  },
});

test("where the blocked pointerout goes", async ({ junto }) => {
  test.setTimeout(600_000);
  const { page } = junto;
  mkdirSync(OUT, { recursive: true });

  await expect
    .poll(() => page.evaluate(() => Array.isArray((window as unknown as { __pointer?: unknown[] }).__pointer)), { timeout: 60_000 })
    .toBe(true);
  for (const id of IDS) await card(page, id).visible({ timeout: 120_000 });
  await page.waitForTimeout(4_000);

  const selectAll = async (): Promise<void> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await card(page, IDS[0]).click();
      for (const id of IDS.slice(1)) await card(page, id).click({ modifiers: ["Shift"] });
      if ([...(await selectedIds(page))].sort().join() === [...IDS].sort().join()) return;
      await page.waitForTimeout(400);
    }
    throw new Error(`selection is ${JSON.stringify(await selectedIds(page))}`);
  };

  const openMode = process.env.JUNTO_OPEN ?? "grid";
  if (openMode !== "grid") {
    // The docked open: the case the 263 ms blocked pointerout was seen on.
    await card(page, IDS[0]).dblclick();
    const surface = page.locator(".native-terminal-surface").first();
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const seatResult = await page.evaluate(() => ({
      pointer: (window as unknown as { __pointer?: unknown[] }).__pointer ?? [],
      longtasks: (window as unknown as { __longtasks?: unknown[] }).__longtasks ?? [],
    }));
    writeFileSync(`${OUT}/pointer-seat.json`, JSON.stringify(seatResult));
    for (const row of (seatResult.pointer as Array<{ type: string; tag: string; own: number; handler?: string }>).sort((a, b) => b.own - a.own).slice(0, 12)) {
      console.log(`seat pointer ${row.own.toFixed(1).padStart(8)} ms  ${row.type} on ${row.tag} (${row.handler ?? "?"})`);
    }
    for (const row of (seatResult.longtasks as Array<{ start: number; duration: number }>).sort((a, b) => b.duration - a.duration).slice(0, 6)) {
      console.log(`seat longtask ${row.duration.toFixed(1).padStart(8)} ms at ${row.start.toFixed(0)}`);
    }
    return;
  }
  await selectAll();
  await page.evaluate(() => {
    const host = window as unknown as { __pointer?: unknown[]; __longtasks?: unknown[] };
    host.__pointer = [];
    host.__longtasks = [];
  });
  await page.getByTestId("rts-open-grid").click();
  const grid = page.locator("[data-testid='terminal-grid-focus']");
  await expect(grid).toBeVisible({ timeout: 30_000 });
  await expect(grid.locator(".native-terminal-surface--grid .xterm")).toHaveCount(4, { timeout: 60_000 });
  await page.waitForTimeout(4_000);

  const result = await page.evaluate(() => ({
    pointer: (window as unknown as { __pointer?: unknown[] }).__pointer ?? [],
    longtasks: (window as unknown as { __longtasks?: unknown[] }).__longtasks ?? [],
  }));
  writeFileSync(`${OUT}/pointer.json`, JSON.stringify(result));
  const slow = (result.pointer as Array<{ type: string; tag: string; own: number; handler?: string }>)
    .sort((a, b) => b.own - a.own)
    .slice(0, 15);
  for (const row of slow) console.log(`pointer ${row.own.toFixed(1).padStart(8)} ms  ${row.type} on ${row.tag} (${row.handler ?? "?"})`);
  const long = (result.longtasks as Array<{ start: number; duration: number }>).sort((a, b) => b.duration - a.duration).slice(0, 8);
  for (const row of long) console.log(`longtask ${row.duration.toFixed(1).padStart(8)} ms at ${row.start.toFixed(0)}`);
  if (slow.length === 0) console.log("no pointer listener took 2 ms or more");
});
