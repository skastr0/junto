/**
 * A derives wire is a track of filled arrowheads in its own token, pointing
 * from the origin board to each target, that never move forward: they hold
 * their place and breathe together on the compositor, at every tier, while
 * a flows track beside them slides. Rewire swaps one look for the other as
 * the verb changes, both ways.
 *
 *   bun run test:e2e:fast e2e/scenarios/canvas-derive-track.spec.ts
 */
import type { Page } from "@playwright/test";
import { Node } from "../../src/shared/model";
import { Schema } from "effect";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelRegion, modelWire } from "../harness/model";

const CANVAS = "derive-track";

const decode = (input: unknown): Node => Schema.decodeUnknownSync(Node, { onExcessProperty: "error" })(input);
const at = (x: number, y: number, width: number, height: number) => ({ x, y, width, height, z: 0 });

const TIERS = [
  ["near", 0.8],
  ["far", 0.26],
  ["overview", 0.15],
] as const;

const scale = (page: Page): Promise<number> =>
  page.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a);

/** Ctrl-wheel about the lane's centre until the camera reaches `goal`. */
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

type TrackLook = {
  readonly verb: string | undefined;
  readonly runs: number;
  /** Runs whose marks slide. */
  readonly sliding: number;
  /** Runs that breathe, and any property their breath animates but opacity. */
  readonly breathing: number;
  readonly breathOff: ReadonlyArray<string>;
  readonly colour: string;
  /** Sum of the runs as vectors, dotted with the line from source centre to target centre. */
  readonly toward: number;
};

const lookOf = (page: Page, id: string, from: string, to: string): Promise<TrackLook> =>
  page.evaluate(
    ({ id, from, to }) => {
      const track = document.querySelector<HTMLElement>(`.junto-flow-track[data-edge-id="${id}"]`);
      const runs = [...(track?.querySelectorAll<HTMLElement>(".junto-flow-track__run") ?? [])];
      let sliding = 0;
      let breathing = 0;
      const breathOff = new Set<string>();
      let x = 0;
      let y = 0;
      for (const run of runs) {
        if (run.querySelector(".junto-flow-track__mover")!.getAnimations().some((a) => a.playState === "running")) sliding += 1;
        const own = run.getAnimations({ subtree: false }).filter((a) => (a.effect as KeyframeEffect).target === run);
        if (own.some((a) => a.playState === "running")) breathing += 1;
        for (const a of own) {
          for (const frame of (a.effect as KeyframeEffect).getKeyframes()) {
            for (const key of Object.keys(frame)) {
              if (!["offset", "easing", "composite", "computedOffset", "opacity"].includes(key)) breathOff.add(key);
            }
          }
        }
        const angle = (Number(/rotate\((-?[\d.e-]+)deg\)/.exec(run.style.transform)?.[1] ?? 0) * Math.PI) / 180;
        x += Math.cos(angle) * run.offsetWidth;
        y += Math.sin(angle) * run.offsetWidth;
      }
      const centre = (node: string) => {
        const r = document.querySelector(`.react-flow__node[data-id="${node}"]`)!.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const a = centre(from);
      const b = centre(to);
      const marks = track?.querySelector(".junto-flow-track__marks");
      return {
        verb: track?.dataset.verb,
        runs: runs.length,
        sliding,
        breathing,
        breathOff: [...breathOff],
        colour: marks ? getComputedStyle(marks).backgroundColor : "",
        toward: x * (b.x - a.x) + y * (b.y - a.y),
      };
    },
    { id, from, to },
  );

const tokenColour = (page: Page, token: string): Promise<string> =>
  page.evaluate((name) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);

const rewire = (page: Page, id: string, verb: "flows" | "derives") =>
  page.evaluate(
    async ({ canvas, id, verb }) => {
      await window.junto!.modelCommand({ _tag: "Rewire", canvas, id, change: { verb } } as never);
    },
    { canvas: CANVAS, id, verb },
  );

test("a derives wire holds still filled arrowheads that breathe, beside a sliding flows track, and Rewire swaps the looks", async () => {
  test.setTimeout(180_000);
  const nodes: Node[] = [
    modelRegion({ id: "lane", label: "release lane", x: 0, y: 0, width: 1500, height: 700 }),
    decode({ kind: "task", id: "intake", name: "Intake", ...at(60, 250, 300, 200) }),
    decode({ kind: "task", id: "docs", name: "Docs", ...at(620, 60, 300, 200) }),
    decode({ kind: "task", id: "qa", name: "QA", ...at(620, 440, 300, 200) }),
    decode({ kind: "task", id: "ship", name: "Ship", ...at(1160, 250, 300, 200) }),
  ];
  const wires = [
    modelWire("intake-docs", "intake", "docs", "derives", nodes),
    modelWire("intake-qa", "intake", "qa", "derives", nodes),
    modelWire("docs-ship", "docs", "ship", "flows", nodes),
  ];
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, wires) },
    windowContentSize: { width: 1720, height: 1080 },
  });
  try {
    const { page } = junto;
    await expect(page.locator('.react-flow__node[data-id="intake"]')).toBeVisible({ timeout: 30_000 });
    await page.mouse.click(4, 4);
    await page.keyboard.press("Escape");
    const derivesInk = await tokenColour(page, "--wire-verb-derives");

    for (const [tier, zoom] of TIERS) {
      await zoomTo(page, zoom);
      await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
      for (const [id, to] of [["intake-docs", "docs"], ["intake-qa", "qa"]] as const) {
        const seen = await lookOf(page, id, "intake", to);
        const label = `${tier} ${id}`;
        expect(seen.verb, label).toBe("derives");
        expect(seen.runs, `${label}: lays its runs`).toBeGreaterThan(0);
        expect(seen.sliding, `${label}: no arrowhead moves forward`).toBe(0);
        expect(seen.breathing, `${label}: every run breathes`).toBe(seen.runs);
        expect(seen.breathOff, `${label}: the breath is opacity alone`).toEqual([]);
        expect(seen.colour, `${label}: drawn in --wire-verb-derives`).toBe(derivesInk);
        expect(seen.toward, `${label}: points to the target board`).toBeGreaterThan(0);
      }
      const flows = await lookOf(page, "docs-ship", "docs", "ship");
      expect(flows.verb, `${tier}: flows beside it`).toBe("flows");
      expect(flows.sliding, `${tier}: the flows track still slides`).toBe(flows.runs);
      expect(flows.breathing, `${tier}: the flows track never breathes`).toBe(0);
    }

    // Rewire swaps the look with the verb, and back.
    await zoomTo(page, 0.8);
    await rewire(page, "docs-ship", "derives");
    await expect(page.locator('.junto-flow-track[data-edge-id="docs-ship"]')).toHaveAttribute("data-verb", "derives");
    await expect.poll(async () => (await lookOf(page, "docs-ship", "docs", "ship")).sliding).toBe(0);
    const swapped = await lookOf(page, "docs-ship", "docs", "ship");
    expect(swapped.breathing, "rewired to derives: breathes").toBe(swapped.runs);
    await rewire(page, "docs-ship", "flows");
    await expect(page.locator('.junto-flow-track[data-edge-id="docs-ship"]')).toHaveAttribute("data-verb", "flows");
    await expect.poll(async () => {
      const back = await lookOf(page, "docs-ship", "docs", "ship");
      return back.sliding === back.runs && back.breathing === 0;
    }).toBe(true);
  } finally {
    await junto.close();
  }
});
