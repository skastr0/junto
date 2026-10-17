/**
 * Rings on seats inside nested regions (the `nested` board: four levels,
 * 44 regions of uneven size, about 200 seats) at every zoom tier, dark and
 * bright: rings animate, nothing paints over or clips them at region edges,
 * turning parts stay on centre, and reduced motion shows the rest pose.
 * Frames and a JSON probe per tier land in test-results/ring-regions/.
 */
import { mkdir, writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { buildNestedCanvasFixture, OPERATOR_DISPLAY } from "../harness/nested-canvas-fixture";
import { expect, test } from "../harness/launch";

const SHOTS = "test-results/ring-regions";
const fixture = buildNestedCanvasFixture("nested");
const seats = fixture.model.nodes.filter((n): n is Extract<typeof n, { kind: "agent" }> => n.kind === "agent");

test.use({ juntoOptions: { ...OPERATOR_DISPLAY, nestedCanvas: { fixture, name: "nested" } } });

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

const zoomTo = async (page: Page, goal: number): Promise<number> => {
  await page.evaluate((target) => {
    const read = () => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - target) / target < 0.04) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", { deltaY: now > target ? 20 : -20, ctrlKey: true, clientX: flow.x + flow.width / 2, clientY: flow.y + flow.height / 2 - 60, bubbles: true, cancelable: true }),
      );
    }
  }, goal);
  await page.waitForTimeout(900);
  return scale(page);
};

/** Every on-screen ring: depth of its innermost region, motion, centring, cover and clip. */
const probe = (page: Page) =>
  page.evaluate(() => {
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    const regions = [...document.querySelectorAll<HTMLElement>(".junto-group")].map((g) => ({
      r: g.getBoundingClientRect(),
      depth: Number(g.dataset.regionDepth ?? 0),
    }));
    // Rings wholly inside the canvas, and not under the chrome docked over it:
    // a ring cut by the window edge is the camera, not a region.
    const marks = [...document.querySelectorAll<HTMLElement>(".react-flow__node .junto-mark")].filter((m) => {
      const r = m.getBoundingClientRect();
      const inFlow = r.width > 0 && r.left >= flow.left && r.right <= flow.right && r.top >= flow.top && r.bottom <= flow.bottom;
      // Chrome docked over the canvas (toolbar, deck, minimap) takes the corners' hit.
      const corners = [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1], [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1]] as const;
      const underChrome = corners.some(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !hit || !hit.closest(".react-flow") || hit.closest(".react-flow__panel") !== null;
      });
      return inFlow && !underChrome;
    });
    const nodeOf = (el: Element) => el.closest<HTMLElement>(".react-flow__node");
    const order = [...document.querySelectorAll<HTMLElement>(".react-flow__node")];
    // Paint order of two flow nodes: z-index first, then DOM order.
    const above = (a: HTMLElement, b: HTMLElement) => {
      const za = Number(getComputedStyle(a).zIndex) || 0, zb = Number(getComputedStyle(b).zIndex) || 0;
      return za !== zb ? za > zb : order.indexOf(a) > order.indexOf(b);
    };
    const groups = [...document.querySelectorAll<HTMLElement>(".react-flow__node-group")];
    const rows = marks.map((m) => {
      const r = m.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const inside = regions.filter((g) => g.r.left <= r.left && g.r.right >= r.right && g.r.top <= r.top && g.r.bottom >= r.bottom);
      const straddles = regions.some((g) => {
        const overlaps = g.r.left < r.right && g.r.right > r.left && g.r.top < r.bottom && g.r.bottom > r.top;
        return overlaps && !inside.includes(g);
      });
      // Off-centre: a turning part's box centre must sit on the mark's.
      // Parts hidden by CSS (offscreen, landed, paused) have no box: skip them.
      const offCentre = [...m.querySelectorAll<HTMLElement>(".junto-mark__part")].filter((p) => p.getBoundingClientRect().width > 0).map((p) => {
        const q = p.getBoundingClientRect();
        return Math.hypot(q.left + q.width / 2 - cx, q.top + q.height / 2 - cy);
      });
      // Clip: any ancestor that clips (overflow not visible) and cuts the mark's box.
      let clipped = false;
      for (let a = m.parentElement; a && !a.classList.contains("react-flow"); a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflow !== "visible" || s.clipPath !== "none") {
          const c = a.getBoundingClientRect();
          if (c.left > r.left + 0.5 || c.right < r.right - 0.5 || c.top > r.top + 0.5 || c.bottom < r.bottom - 0.5) clipped = true;
        }
      }
      // Covered: a region node that overlaps the ring and paints above its seat.
      const seat = nodeOf(m);
      const covered = !!seat && groups.some((g) => {
        const q = g.getBoundingClientRect();
        return q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top && above(g, seat);
      });
      return {
        ring: m.dataset.markRing,
        motion: m.dataset.markMotion,
        size: Math.round(r.width),
        depth: inside.length ? Math.max(...inside.map((g) => g.depth)) + 1 : 0,
        running: m.getAnimations({ subtree: true }).filter((a) => a.playState === "running").length,
        visible: m.hasAttribute("data-mark-visible"),
        offCentre: offCentre.length ? Math.max(...offCentre) : 0,
        clipped,
        covered,
        straddles,
      };
    });
    const loops = rows.filter((x) => x.motion === "loop");
    return {
      tier: document.documentElement.dataset.canvasTier,
      motion: document.documentElement.dataset.surfaceMotion,
      rings: rows.length,
      byDepth: rows.reduce<Record<string, number>>((acc, x) => ((acc[x.depth] = (acc[x.depth] ?? 0) + 1), acc), {}),
      loops: loops.length,
      loopsNotRunning: loops.filter((x) => x.running === 0).length,
      maxOffCentre: Math.max(0, ...rows.map((x) => x.offCentre)),
      clipped: rows.filter((x) => x.clipped).length,
      covered: rows.filter((x) => x.covered).length,
      straddling: rows.filter((x) => x.straddles).length,
      sizes: [...new Set(rows.map((x) => x.size))].sort((a, b) => a - b),
    };
  });

/** Up to four ring crops from the deepest regions on screen, four frames each. */
const ringFrames = async (page: Page, tag: string) => {
  const marks = page.locator(".react-flow__node:not(.react-flow__node-group) .junto-mark[data-mark-visible]");
  const n = Math.min(await marks.count(), 4);
  for (let i = 0; i < n; i += 1) {
    const box = await marks.nth(i).boundingBox();
    if (!box) continue;
    const pad = Math.max(6, box.width * 0.35);
    for (let f = 0; f < 4; f += 1) {
      await page.screenshot({ path: `${SHOTS}/${tag}-ring${String(i)}-f${String(f)}.png`, clip: { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 } });
      await page.waitForTimeout(200);
    }
  }
};

const TIERS = [["near", 0.8], ["mid", 0.45], ["far", 0.26], ["overview", 0.16]] as const;

test("rings in nested regions animate, stay on centre, unclipped, and rest when paused", async ({ junto }) => {
  test.setTimeout(300_000);
  await mkdir(SHOTS, { recursive: true });
  const { page, app } = junto;
  await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 60_000 });
  // Seats work; a few finish, want input. Seat state is broadcast by main.
  const at = Date.now();
  await app.evaluate(({ BrowserWindow }, { keys, at: now }) => {
    for (const window of BrowserWindow.getAllWindows())
      keys.forEach((bindingId, i) => {
        const state = i % 9 === 4 ? "attention" : "working";
        window.webContents.send("junto:agent-seat-state-changed", { bindingId, epoch: "e2e", state, reason: "rule:osc_title_working", confidence: "high", at: now });
        if (i % 9 === 7) window.webContents.send("junto:agent-seat-state-changed", { bindingId, epoch: "e2e", state: "idle", reason: "rule:empty_prompt_idle", confidence: "high", at: now + 1 });
      });
  }, { keys: seats.map((s) => s.bindingId), at });
  const report: Record<string, unknown> = { stats: fixture.stats };
  for (const theme of ["dark", "bright"] as const) {
    await page.evaluate(async (next) => window.junto!.settingsPatch({ appearance: { theme: next } }), theme);
    for (const [tier, zoom] of TIERS) {
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(800);
      const z = await zoomTo(page, zoom);
      await page.waitForTimeout(600);
      const tag = `${theme}-${tier}`;
      for (let f = 0; f < 3; f += 1) {
        await page.screenshot({ path: `${SHOTS}/${tag}-f${String(f)}.png` });
        await page.waitForTimeout(300);
      }
      await ringFrames(page, tag);
      const live = await probe(page);
      // Paused: reduced motion holds every ring at rest.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
      await page.waitForTimeout(400);
      const paused = await probe(page);
      await page.screenshot({ path: `${SHOTS}/${tag}-paused.png` });
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
      await cdp.detach();
      await page.waitForTimeout(300);
      report[tag] = { zoom: z, live, paused: { motion: paused.motion, loops: paused.loops, running: paused.loops - paused.loopsNotRunning } };
      console.log(`RING-REGIONS ${tag} zoom=${z.toFixed(2)} ${JSON.stringify(report[tag])}`);
    }
  }
  await writeFile(`${SHOTS}/report.json`, JSON.stringify(report, null, 1));
  // Rings live at every region depth, over the zooms of each theme (no one
  // camera holds all four levels unobstructed).
  for (const theme of ["dark", "bright"]) {
    const seen = new Set(
      TIERS.flatMap(([tier]) => {
        const { live } = report[`${theme}-${tier}`] as { live: Awaited<ReturnType<typeof probe>> };
        return Object.keys(live.byDepth).map(Number);
      }),
    );
    for (const depth of [1, 2, 3, 4]) expect.soft(seen.has(depth), `${theme}: rings at region depth ${String(depth)}`).toBe(true);
  }
  for (const [tag, row] of Object.entries(report)) {
    if (tag === "stats") continue;
    const { live, paused } = row as { live: Awaited<ReturnType<typeof probe>>; paused: { motion: string; running: number } };
    expect.soft(live.loops, `${tag}: looping rings on screen`).toBeGreaterThan(0);
    expect.soft(live.loopsNotRunning, `${tag}: looping rings not animating`).toBe(0);
    expect.soft(live.maxOffCentre, `${tag}: turning part off centre (px)`).toBeLessThan(1);
    expect.soft(live.clipped, `${tag}: rings clipped`).toBe(0);
    expect.soft(live.covered, `${tag}: rings painted over by a region`).toBe(0);
    expect.soft(paused.motion, `${tag}: paused`).toBe("paused");
    expect.soft(paused.running, `${tag}: rings running while paused`).toBe(0);
  }
});
