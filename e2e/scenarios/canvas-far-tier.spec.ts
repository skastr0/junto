/**
 * The far tier is a board the operator works from: on the `max` stress board
 * (about 250 seats in 138 regions, five levels deep) at the operator's
 * display, a pulled-back camera shows every seat as its portrait in its
 * state ring, held at 40px on screen unless a neighbour is nearer and never
 * meeting one, with a heavy halo on every seat that needs the operator;
 * every card as a faint block with its kind's glyph; every region in its
 * colour with a frame; and every named region's name in large capitals,
 * nested ones included, none overlapping another. Hover, select and open
 * work on a seat from there.
 *
 * Frames land in test-results/canvas-far-tier/ (near, mid, far; dark and
 * bright). Paint and tile budgets per tier live in canvas-tier-budget.spec.ts.
 *
 *   bun run test:e2e:fast e2e/scenarios/canvas-far-tier.spec.ts
 */
import { mkdir } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { buildNestedCanvasFixture, OPERATOR_DISPLAY } from "../harness/nested-canvas-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = "test-results/canvas-far-tier";

const TIERS = [
  ["near", 0.8],
  ["mid", 0.45],
  ["far", 0.26],
] as const;

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

const zoomTo = async (page: Page, target: number): Promise<number> => {
  await page.evaluate((goal) => {
    const read = (): number =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const flow = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - goal) / goal < 0.04) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > goal ? 20 : -20,
          ctrlKey: true,
          clientX: flow.x + flow.width / 2,
          clientY: flow.y + flow.height / 2 - 60,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, target);
  await page.waitForTimeout(1_200);
  return scale(page);
};

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

/** Seat N is bound as local:stress-N. 0 working, 1 done and unread, 2 waiting, 3 resting. */
const seatEvents = (seats: number, at: number) =>
  Array.from({ length: seats }, (_, index) => index + 1).flatMap((n) => {
    const event = (state: string, offset: number) => ({
      bindingId: `local:stress-${String(n)}`,
      epoch: "far",
      state,
      reason:
        state === "idle" ? "rule:empty_prompt_idle" : state === "attention" ? "rule:approval_prompt" : "rule:osc_title_working",
      confidence: "high",
      at: at + offset,
    });
    const kind = n % 4;
    if (kind === 0) return [event("working", 0)];
    if (kind === 1) return [event("working", 0), event("idle", 1)];
    if (kind === 2) return [event("attention", 0)];
    return [event("idle", 0)];
  });

type FarLook = {
  readonly names: number;
  readonly namedOnScreen: number;
  readonly silent: ReadonlyArray<string>;
  readonly collisions: ReadonlyArray<string>;
  readonly smallestNamePx: number;
  readonly seatsOnScreen: number;
  readonly seatsWithoutPortrait: number;
  readonly seatsWithoutRing: number;
  readonly seatsWithWords: number;
  readonly smallestRingPx: number;
  /** Rings drawn smaller than min(40px, the room their neighbours leave). */
  readonly ringsUnderFloor: ReadonlyArray<string>;
  readonly ringsAtFloor: number;
  readonly ringOverlaps: ReadonlyArray<string>;
  /** Region names whose ink runs into a seat's ring. */
  readonly namesOverRings: ReadonlyArray<string>;
  /** Seats that need the operator without a halo, and quiet seats with one. */
  readonly needsYouUnmarked: number;
  readonly quietMarked: number;
  readonly needsYou: number;
  readonly blocksWithoutGlyph: number;
  readonly rings: ReadonlyArray<string>;
  readonly colouredRegions: number;
  readonly colouredWithoutFrame: number;
  readonly nestedColouredWithoutFill: number;
};

/** What the far camera shows, read from the rendered page. */
const readFar = (page: Page): Promise<FarLook> =>
  page.evaluate(() => {
    const view = document.querySelector(".react-flow")!.getBoundingClientRect();
    const onScreen = (r: DOMRect): boolean =>
      r.width > 0 && r.left >= view.left && r.right <= view.right && r.top >= view.top && r.bottom <= view.bottom;
    const zoom = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    const texts = [...document.querySelectorAll<HTMLElement>(".react-flow__viewport .junto-region-glance__text")];
    const shown: { id: string; rect: DOMRect }[] = [];
    const silent: string[] = [];
    let smallest = Number.POSITIVE_INFINITY;
    for (const text of texts) {
      const glance = text.parentElement!;
      const region = glance.closest(".react-flow__node")!;
      const regionRect = region.getBoundingClientRect();
      if (!onScreen(regionRect)) continue;
      const id = region.getAttribute("data-id") ?? "?";
      const opacity = Number(getComputedStyle(glance).opacity);
      const visible = getComputedStyle(text).visibility !== "hidden" && opacity > 0.5;
      if (!visible) {
        silent.push(id);
        continue;
      }
      // The ink, not the box: a Range hugs the glyphs.
      const range = document.createRange();
      range.selectNodeContents(text);
      shown.push({ id, rect: range.getBoundingClientRect() });
      smallest = Math.min(smallest, Number.parseFloat(getComputedStyle(text).fontSize) * zoom);
    }
    const collisions: string[] = [];
    for (let i = 0; i < shown.length; i += 1) {
      for (let j = i + 1; j < shown.length; j += 1) {
        const a = shown[i]!.rect;
        const b = shown[j]!.rect;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) {
          collisions.push(`${shown[i]!.id} x ${shown[j]!.id}`);
        }
      }
    }
    const seats = [...document.querySelectorAll<HTMLElement>('.react-flow__viewport .junto-node[data-node-kind="agent"]')].filter(
      (seat) => onScreen(seat.getBoundingClientRect()),
    );
    let withoutPortrait = 0;
    let withoutRing = 0;
    let withWords = 0;
    let smallestRing = Number.POSITIVE_INFINITY;
    const rings = new Set<string>();
    const under: string[] = [];
    let atFloor = 0;
    let needsYou = 0;
    let needsYouUnmarked = 0;
    let quietMarked = 0;
    const circles: { id: string; x: number; y: number; r: number }[] = [];
    for (const seat of seats) {
      const mark = seat.querySelector<HTMLElement>('.junto-mark[data-mark-size="seat"]');
      const portrait = seat.querySelector<HTMLElement>(".junto-mark__seat img, .junto-mark__seat svg");
      if (!mark || getComputedStyle(mark).backgroundImage === "none") withoutRing += 1;
      if (!portrait || getComputedStyle(portrait).visibility === "hidden") withoutPortrait += 1;
      const words = seat.querySelector<HTMLElement>(".junto-seat__text");
      if (words && getComputedStyle(words).visibility !== "hidden") withWords += 1;
      if (mark) {
        const box = mark.getBoundingClientRect();
        const node = seat.closest<HTMLElement>(".react-flow__node")!;
        const id = node.getAttribute("data-id") ?? "?";
        const cap = Number.parseFloat(node.style.getPropertyValue("--ring-cap") || "1.75");
        const floor = Math.min(40, cap * 52 * zoom);
        if (box.width < floor - 1.5) under.push(`${id} ${box.width.toFixed(1)} < ${floor.toFixed(1)}`);
        if (box.width >= 39.5) atFloor += 1;
        smallestRing = Math.min(smallestRing, box.width);
        circles.push({ id, x: box.left + box.width / 2, y: box.top + box.height / 2, r: box.width / 2 });
        const ring = mark.getAttribute("data-mark-ring") ?? "?";
        rings.add(ring);
        const halo = getComputedStyle(seat.querySelector(".junto-seat")!, "::before").boxShadow !== "none";
        if (["call", "wait", "halt"].includes(ring)) {
          needsYou += 1;
          if (!halo) needsYouUnmarked += 1;
        } else if (halo) quietMarked += 1;
      }
    }
    const ringOverlaps: string[] = [];
    for (let i = 0; i < circles.length; i += 1) {
      for (let j = i + 1; j < circles.length; j += 1) {
        const a = circles[i]!;
        const b = circles[j]!;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r - 0.5) ringOverlaps.push(`${a.id} x ${b.id}`);
      }
    }
    const namesOverRings: string[] = [];
    for (const name of shown) {
      for (const c of circles) {
        const nx = Math.max(name.rect.left, Math.min(c.x, name.rect.right));
        const ny = Math.max(name.rect.top, Math.min(c.y, name.rect.bottom));
        if (Math.hypot(nx - c.x, ny - c.y) < c.r - 1) namesOverRings.push(`${name.id} x ${c.id}`);
      }
    }
    const blocks = [
      ...document.querySelectorAll<HTMLElement>(
        '.react-flow__viewport .junto-node:not([data-bare]):not([data-node-kind="agent"]):not([data-node-kind="terminal"]):not([data-node-kind="git"])',
      ),
    ].filter((block) => onScreen(block.getBoundingClientRect()));
    const blocksWithoutGlyph = blocks.filter((block) => getComputedStyle(block, "::before").maskImage === "none").length;
    const groups = [...document.querySelectorAll<HTMLElement>(".react-flow__viewport .junto-group[data-region-colored]")].filter(
      (group) => onScreen(group.getBoundingClientRect()),
    );
    const clear = (colour: string): boolean => colour === "transparent" || /rgba?\([^)]*,\s*0\)$/.test(colour);
    return {
      names: texts.length,
      namedOnScreen: shown.length,
      silent,
      collisions,
      smallestNamePx: Number.isFinite(smallest) ? smallest : 0,
      seatsOnScreen: seats.length,
      seatsWithoutPortrait: withoutPortrait,
      seatsWithoutRing: withoutRing,
      seatsWithWords: withWords,
      smallestRingPx: Number.isFinite(smallestRing) ? smallestRing : 0,
      ringsUnderFloor: under,
      ringsAtFloor: atFloor,
      ringOverlaps,
      namesOverRings,
      needsYouUnmarked,
      quietMarked,
      needsYou,
      blocksWithoutGlyph,
      rings: [...rings].sort(),
      colouredRegions: groups.length,
      colouredWithoutFrame: groups.filter((group) => Number.parseFloat(getComputedStyle(group).outlineWidth) < 5).length,
      nestedColouredWithoutFill: groups.filter(
        (group) => group.getAttribute("data-region-depth") !== "0" && clear(getComputedStyle(group).backgroundColor),
      ).length,
    };
  });

test("far tier: every seat a portrait in its ring, every region coloured and named, none overlapping", async () => {
  test.setTimeout(300_000);
  await mkdir(SHOTS, { recursive: true });
  const fixture = buildNestedCanvasFixture("max");
  expect(fixture.stats.seats).toBeGreaterThanOrEqual(200);
  expect(fixture.stats.depth).toBeGreaterThanOrEqual(5);
  const junto = await launchJunto({ ...OPERATOR_DISPLAY, nestedCanvas: { fixture, name: "max" } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow__node-group")).toHaveCount(fixture.stats.regions, { timeout: 60_000 });
    await app.evaluate(
      ({ BrowserWindow }, events) => {
        for (const win of BrowserWindow.getAllWindows()) {
          for (const event of events) win.webContents.send("junto:agent-seat-state-changed", event);
        }
      },
      seatEvents(fixture.stats.seats, Date.now()),
    );
    // The states land: working, done, waiting and resting rings side by side.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Set(
                [...document.querySelectorAll('.junto-mark[data-mark-size="seat"]')].map((mark) =>
                  mark.getAttribute("data-mark-ring"),
                ),
              ).size,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(4);

    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(800);
      for (const [tier, zoom] of TIERS) {
        await zoomTo(page, zoom);
        await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${SHOTS}/${theme}-${tier}.png` });
      }

      const look = await readFar(page);
      console.log(`FAR-TIER ${theme} ${JSON.stringify(look)}`);
      // Names: every named region on screen prints one, legible, and no two meet.
      expect(look.namedOnScreen, "regions named on screen").toBeGreaterThanOrEqual(10);
      expect(look.silent, "regions on screen with no name").toEqual([]);
      expect(look.collisions, "names that overlap").toEqual([]);
      expect(look.smallestNamePx, "smallest name on screen, px").toBeGreaterThanOrEqual(8);
      // Seats: a portrait in a ring, no words, big enough to tell apart.
      expect(look.seatsOnScreen).toBeGreaterThanOrEqual(30);
      expect(look.seatsWithoutRing).toBe(0);
      expect(look.seatsWithoutPortrait).toBe(0);
      expect(look.seatsWithWords).toBe(0);
      // Rings: 40px on screen unless a neighbour is nearer, and never meeting one.
      expect(look.ringsUnderFloor, "rings under min(40px, their room)").toEqual([]);
      expect(look.ringOverlaps, "rings that meet").toEqual([]);
      expect(look.namesOverRings, "region names printed over a seat").toEqual([]);
      expect(look.smallestRingPx, "ring diameter on screen, px").toBeGreaterThanOrEqual(24);
      // Needs-you seats carry a halo, and only they do.
      expect(look.needsYou).toBeGreaterThan(0);
      expect(look.needsYouUnmarked).toBe(0);
      expect(look.quietMarked).toBe(0);
      expect(look.blocksWithoutGlyph, "cards without their kind's glyph").toBe(0);
      expect(look.rings.length, `ring states shown: ${look.rings.join(", ")}`).toBeGreaterThanOrEqual(3);
      // Regions: a frame in their colour, nested ones filled too.
      expect(look.colouredRegions).toBeGreaterThan(0);
      expect(look.colouredWithoutFrame).toBe(0);
      expect(look.nestedColouredWithoutFill).toBe(0);
    }

    // Work from the far camera: hover names a seat, a click selects it, a
    // double click opens it.
    const target = await page.evaluate(() => {
      const view = document.querySelector(".react-flow")!.getBoundingClientRect();
      const cx = view.left + view.width / 2;
      const cy = view.top + view.height / 2;
      let best: { id: string; x: number; y: number; d: number } | undefined;
      for (const node of document.querySelectorAll<HTMLElement>('.react-flow__viewport .react-flow__node')) {
        if (!node.querySelector('.junto-node[data-node-kind="agent"]')) continue;
        const mark = node.querySelector<HTMLElement>('.junto-mark[data-mark-size="seat"]')!.getBoundingClientRect();
        const x = mark.left + mark.width / 2;
        const y = mark.top + mark.height / 2;
        const d = Math.hypot(x - cx, y - cy);
        if (!best || d < best.d) best = { id: node.getAttribute("data-id")!, x, y, d };
      }
      return best!;
    });
    const seat = page.locator(`.react-flow__node[data-id="${target.id}"]`);
    const tag = seat.locator(".junto-seat__text");
    await expect(tag).toHaveCSS("visibility", "hidden");
    await page.mouse.move(target.x, target.y);
    await expect(tag).toHaveCSS("visibility", "visible");
    await expect(tag).toContainText("seat");
    const tagBox = (await tag.boundingBox())!;
    expect(tagBox.height, "name tag height on screen, px").toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: `${SHOTS}/bright-far-hover.png` });
    await page.mouse.click(target.x, target.y);
    await expect(seat).toHaveClass(/selected/);
    await page.mouse.move(target.x + 400, target.y + 300);
    await expect(tag).toHaveCSS("visibility", "visible");
    await page.screenshot({ path: `${SHOTS}/bright-far-selected.png` });
    await page.mouse.dblclick(target.x, target.y);
    await expect(page.locator(".native-terminal-surface")).toBeVisible({ timeout: 20_000 });
  } finally {
    await junto.close();
  }
});
