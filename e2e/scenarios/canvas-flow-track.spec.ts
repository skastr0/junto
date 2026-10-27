/**
 * A flows wire is a track: open chevrons in ink, pointing from a task board
 * to the board that depends on it, sliding that way on the compositor, and
 * opaque at every tier and in every state, while a seat's wire beside it
 * stays a faint hairline at rest.
 *
 * Frames land in $JUNTO_SHOTS_DIR (default test-results/canvas-flow-track):
 * <tier>-<theme>.png, cropped to the board.
 *
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/canvas-flow-track.spec.ts
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { Schema } from "effect";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelSeat, modelWire } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? join(process.cwd(), "test-results", "canvas-flow-track");
const CANVAS = "flow-track";

const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, z: 0 });

const TIERS = [
  ["near", 0.8],
  ["mid", 0.45],
  ["far", 0.26],
  ["overview", 0.15],
] as const;

const FLOWS = ["build-review", "review-ship", "build-test", "test-ship", "test-docs"] as const;

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

/** Ctrl-wheel about the board's centre until the camera reaches `goal`. */
const zoomTo = async (page: Page, goal: number): Promise<number> => {
  await page.evaluate((target) => {
    const read = (): number =>
      new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
    for (let i = 0; i < 200; i += 1) {
      const now = read();
      if (Math.abs(now - target) / target < 0.03) break;
      const lane = document.querySelector('.react-flow__node[data-id="lane"]')!.getBoundingClientRect();
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: now > target ? 12 : -12,
          ctrlKey: true,
          clientX: lane.x + lane.width / 2,
          clientY: lane.y + lane.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, goal);
  await page.waitForTimeout(1_200);
  return scale(page);
};

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
  await page.waitForTimeout(400);
};

type TrackLook = {
  readonly runs: number;
  /** Runs not drawn, or drawn under some ancestor's opacity. */
  readonly faded: ReadonlyArray<string>;
  /** Runs whose marks do not slide, or slide by anything but transform. */
  readonly still: number;
  readonly offCompositor: ReadonlyArray<string>;
  readonly colour: string;
  readonly ink: string;
  /**
   * Per flows wire: its runs summed as vectors, dotted with the line from the
   * source board's centre to the target's (positive: the track points to the
   * dependent board), and the sum's x.
   */
  readonly headings: Readonly<Record<string, { readonly toward: number; readonly x: number }>>;
  /** Opacity of the seat wire at rest. */
  readonly seatWire: number;
  /** Pairs of parallel runs, on any tracks, whose strips cross. */
  readonly crossing: ReadonlyArray<string>;
};

const look = (page: Page): Promise<TrackLook> =>
  page.evaluate((ids) => {
    const runs = [...document.querySelectorAll<HTMLElement>(".junto-flow-track__run")];
    const faded: string[] = [];
    let still = 0;
    const offCompositor = new Set<string>();
    for (const run of runs) {
      let alpha = 1;
      for (let el: Element | null = run; el && !el.classList.contains("react-flow"); el = el.parentElement) {
        alpha *= Number(getComputedStyle(el).opacity);
      }
      if (getComputedStyle(run).visibility !== "visible" || alpha < 1) faded.push(`${alpha}`);
      const anims = run.querySelector(".junto-flow-track__mover")!.getAnimations();
      if (!anims.some((a) => a.playState === "running")) still += 1;
      for (const a of anims) {
        for (const frame of (a.effect as KeyframeEffect).getKeyframes()) {
          for (const key of Object.keys(frame)) {
            if (!["offset", "easing", "composite", "computedOffset", "transform"].includes(key)) offCompositor.add(key);
          }
        }
      }
    }
    const headings: Record<string, { toward: number; x: number }> = {};
    const centre = (node: string) => {
      const r = document.querySelector(`.react-flow__node[data-id="${node}"]`)!.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    };
    for (const id of ids) {
      const [from, to] = id.split("-") as [string, string];
      let x = 0;
      let y = 0;
      for (const run of document.querySelectorAll<HTMLElement>(`.junto-flow-track[data-edge-id="${id}"] .junto-flow-track__run`)) {
        const angle = (Number(/rotate\((-?[\d.e-]+)deg\)/.exec(run.style.transform)?.[1] ?? 0) * Math.PI) / 180;
        x += Math.cos(angle) * run.offsetWidth;
        y += Math.sin(angle) * run.offsetWidth;
      }
      const a = centre(from);
      const b = centre(to);
      headings[id] = { toward: x * (b.x - a.x) + y * (b.y - a.y), x };
    }
    const probe = document.createElement("div");
    probe.style.color = "var(--wire-verb-flows)";
    document.body.append(probe);
    const ink = getComputedStyle(probe).color;
    probe.remove();
    // Each strip's box in canvas units, from its own style: a strip is laid
    // from its run's start, turned by a quarter turn about its left middle.
    const strips = runs.map((run) => {
      const x = parseFloat(run.style.left);
      const h = parseFloat(run.style.height);
      const y = parseFloat(run.style.top) + h / 2;
      const len = parseFloat(run.style.width);
      const angle = Math.round(Number(/rotate\((-?[\d.e-]+)deg\)/.exec(run.style.transform)?.[1] ?? 0));
      const box =
        angle === 0 ? { left: x, right: x + len, top: y - h / 2, bottom: y + h / 2 }
        : angle === 180 ? { left: x - len, right: x, top: y - h / 2, bottom: y + h / 2 }
        : angle === 90 ? { left: x - h / 2, right: x + h / 2, top: y, bottom: y + len }
        : { left: x - h / 2, right: x + h / 2, top: y - len, bottom: y };
      return {
        id: `${run.closest<HTMLElement>(".junto-flow-track")!.dataset.edgeId}@${x},${y}`,
        vertical: Math.abs(angle) === 90,
        box,
      };
    });
    const crossing: string[] = [];
    for (let i = 0; i < strips.length; i += 1) {
      for (let j = i + 1; j < strips.length; j += 1) {
        const a = strips[i]!;
        const b = strips[j]!;
        if (a.vertical !== b.vertical) continue;
        const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
        const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
        if (w > 0.01 && h > 0.01) crossing.push(`${a.id} x ${b.id}`);
      }
    }
    const marks = document.querySelector(".junto-flow-track__marks");
    return {
      runs: runs.length,
      faded,
      still,
      offCompositor: [...offCompositor],
      colour: marks ? getComputedStyle(marks).backgroundColor : "",
      ink,
      headings,
      crossing,
      seatWire: Number(getComputedStyle(document.querySelector('.react-flow__edge[data-id="writer-editor"] path.junto-edge')!).opacity),
    };
  }, [...FLOWS]);

const shoot = async (page: Page, name: string): Promise<void> => {
  const box = (await page.locator('.react-flow__node[data-id="lane"]').boundingBox())!;
  const pad = 24;
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + pad * 2, height: box.height + pad * 2 },
  });
};

test("a flows wire is an ink track, sliding toward the dependent board, opaque at every tier and state", async () => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const folder = mkdtempSync(join(tmpdir(), "junto-flow-track-"));
  const seat = (id: string, x: number, y: number) =>
    modelSeat({ id, key: `local:ft-${id}`, label: id, harness: "codex", cwd: folder, x, y });
  const nodes: Node[] = [
    modelRegion({ id: "lane", label: "release lane", x: 0, y: 0, width: 1420, height: 900 }),
    decode({ kind: "task", id: "build", name: "Build", ...at(60, 70, 300, 200) }),
    decode({ kind: "task", id: "review", name: "Review", ...at(560, 70, 300, 200) }),
    decode({ kind: "task", id: "ship", name: "Ship", ...at(1060, 260, 300, 200) }),
    decode({ kind: "task", id: "test", name: "Test", ...at(560, 470, 300, 200) }),
    decode({ kind: "task", id: "docs", name: "Docs", ...at(60, 470, 300, 200) }),
    seat("writer", 120, 760),
    seat("editor", 720, 760),
  ];
  const wires = [
    modelWire("build-review", "build", "review", "flows", nodes),
    modelWire("review-ship", "review", "ship", "flows", nodes),
    modelWire("build-test", "build", "test", "flows", nodes),
    modelWire("test-ship", "test", "ship", "flows", nodes),
    // Runs right to left: its track reads <<<<.
    modelWire("test-docs", "test", "docs", "flows", nodes, { fromSide: "left", toSide: "right" }),
    modelWire("writer-editor", "writer", "editor", "messages", nodes),
  ];
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, wires) },
    windowContentSize: { width: 1720, height: 1080 },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="build"]')).toBeVisible({ timeout: 30_000 });
    await page.mouse.click(4, 4);
    await page.keyboard.press("Escape");
    for (const [tier, zoom] of TIERS) {
      await zoomTo(page, zoom);
      await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
      for (const theme of ["dark", "bright"] as const) {
        await setTheme(page, theme);
        const seen = await look(page);
        const label = `${tier} ${theme}`;
        expect(seen.runs, `${label}: every flows wire lays its runs`).toBeGreaterThanOrEqual(FLOWS.length);
        expect(seen.faded, `${label}: no run faded or hidden`).toEqual([]);
        expect(seen.still, `${label}: every run slides`).toBe(0);
        expect(seen.offCompositor, `${label}: the slide is transform alone`).toEqual([]);
        expect(seen.crossing, `${label}: no two tracks side by side cross`).toEqual([]);
        expect(seen.colour, `${label}: drawn in ink`).toBe(seen.ink);
        for (const id of FLOWS) {
          expect(seen.headings[id]!.toward, `${label}: ${id} points to the dependent board`).toBeGreaterThan(0);
        }
        expect(seen.headings["test-docs"]!.x, `${label}: test-docs reads <<<<`).toBeLessThan(0);
        if (tier !== "overview") expect(seen.seatWire, `${label}: a seat's wire still rests faint`).toBeLessThan(0.1);
        await shoot(page, `${tier}-${theme}`);
      }
    }

    // Impact and connection focus dim every wire outside the focus; a track
    // is not dimmed.
    await zoomTo(page, 0.8);
    for (const mode of ["impact-mode", "connection-focus-mode"]) {
      await page.evaluate((cls) => document.querySelector(".react-flow")!.classList.add(cls), mode);
      const seen = await look(page);
      expect(seen.faded, `${mode}: no run faded`).toEqual([]);
      await page.evaluate((cls) => document.querySelector(".react-flow")!.classList.remove(cls), mode);
    }

    // Reduced motion holds the chevrons still.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(300);
    const reduced = await look(page);
    expect(reduced.still, "reduced motion: every run holds still").toBe(reduced.runs);
    expect(reduced.faded, "reduced motion: still drawn in full").toEqual([]);
  } finally {
    await junto.close();
  }
});
