/**
 * Canvas level of detail: seats, instruments, notes and cards at each camera
 * tier, in dark and bright. Near draws everything; mid keeps the ring (held
 * still) and the name; far and overview draw a seat as one disc and a card as
 * a flat block. Frames land in test-results/canvas-lod/.
 *
 *   bun run test:e2e:fast e2e/scenarios/canvas-lod.spec.ts
 */
import type { Page } from "@playwright/test";
import type { CanvasEdge, CanvasNode } from "../../src/shared/canvas";
import { agentTextNode, canvasDoc, tasksNode, terminalTextNode, textNode, verbEdge } from "../harness/sandbox";
import { expect, launchJunto, test } from "../harness/launch";

const SHOTS = "test-results/canvas-lod";
const CANVAS = "lod";
const REGIONS = 3;
const SEATS_PER_REGION = 8;

const buildBoard = () => {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  let seat = 0;
  for (let r = 0; r < REGIONS; r += 1) {
    const rx = r * 1_100;
    nodes.push({ id: `rg${r}`, type: "group", label: `crew ${r + 1}`, x: rx, y: 0, width: 1_000, height: 460 });
    const members: string[] = [];
    for (let i = 0; i < SEATS_PER_REGION; i += 1) {
      const id = `s${seat}`;
      nodes.push(
        agentTextNode({
          id,
          key: `local:lod-${seat}`,
          label: `seat ${seat}`,
          x: rx + 30 + (i % 4) * 236,
          y: 50 + Math.floor(i / 4) * 110,
        }),
      );
      members.push(id);
      seat += 1;
    }
    for (let i = 0; i < members.length - 1; i += 1) {
      edges.push(verbEdge(`e${r}-${i}`, members[i]!, members[i + 1]!, "messages", nodes));
    }
    nodes.push({
      ...textNode(`n${r}`, `# plan ${r + 1}\nShip the migration in two steps, then review.`, rx + 30, 280),
      width: 220,
      height: 110,
    });
    nodes.push(terminalTextNode({ id: `t${r}`, bindingId: `local:lod-term-${r}`, label: `shell ${r + 1}`, x: rx + 300, y: 290 }));
    nodes.push(tasksNode({ id: `k${r}`, x: rx + 560, y: 280 }));
  }
  return canvasDoc(nodes, edges);
};

const SEATS = REGIONS * SEATS_PER_REGION;

/** 0 working, 1 done-unread, 2 waiting on the operator, 3 resting. */
const seatEvents = (at: number) =>
  Array.from({ length: SEATS }, (_, i) => i).flatMap((i) => {
    const event = (state: string, offset: number) => ({
      bindingId: `local:lod-${i}`,
      epoch: "lod",
      state,
      reason: state === "idle" ? "rule:empty_prompt_idle" : "rule:osc_title_working",
      confidence: "high",
      at: at + offset,
    });
    const kind = i % 4;
    if (kind === 0) return [event("working", 0)];
    if (kind === 1) return [event("working", 0), event("idle", 1)];
    return [event("idle", 0)];
  });

const signalEvents = (at: number) =>
  Array.from({ length: SEATS }, (_, i) => i)
    .filter((i) => i % 4 === 2)
    .map((i) => ({
      signalId: `lod-${i}`,
      canvasName: CANVAS,
      nodeId: `s${i}`,
      kind: "escalate",
      text: "two specs disagree on ids",
      createdAt: at,
      state: "open",
    }));

const readScale = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const viewport = document.querySelector(".react-flow__viewport");
    const m = (viewport ? getComputedStyle(viewport).transform : "").match(/matrix\(([^)]+)\)/);
    return m ? Number(m[1]!.split(",")[0]) : 1;
  });

/** ctrl+wheel (xyflow's pinch path) about the first region until the scale is near `target`. */
const zoomTo = async (page: Page, target: number): Promise<number> => {
  await page.evaluate((goal) => {
    const scale = (): number => {
      const viewport = document.querySelector(".react-flow__viewport");
      const m = (viewport ? getComputedStyle(viewport).transform : "").match(/matrix\(([^)]+)\)/);
      return m ? Number(m[1]!.split(",")[0]) : 1;
    };
    const anchor = document.querySelector('.react-flow__node[data-id="s5"]')?.getBoundingClientRect();
    const x = anchor ? anchor.x + anchor.width / 2 : window.innerWidth / 2;
    const y = anchor ? anchor.y + anchor.height / 2 : window.innerHeight / 2;
    for (let i = 0; i < 160; i += 1) {
      const now = scale();
      if (Math.abs(now - goal) / goal < 0.04) break;
      document.querySelector(".react-flow__pane")?.dispatchEvent(
        new WheelEvent("wheel", { deltaY: now > goal ? 20 : -20, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }),
      );
    }
  }, target);
  await page.waitForTimeout(900);
  return readScale(page);
};

const setTheme = async (page: Page, theme: "dark" | "bright") => {
  await page.evaluate(async (next) => {
    await window.junto!.settingsPatch({ appearance: { theme: next } });
  }, theme);
  if (theme === "bright") await expect(page.locator("html")).toHaveAttribute("data-theme", "bright");
  else await expect(page.locator("html")).not.toHaveAttribute("data-theme", "bright");
};

const TIERS = [
  ["near", 0.9],
  ["mid", 0.45],
  ["far", 0.26],
  ["overview", 0.17],
] as const;

test("seats, instruments, notes and cards shed detail tier by tier", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: buildBoard() } });
  try {
    const { app, page } = junto;
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.react-flow__node[data-id="s0"]')).toBeAttached({ timeout: 30_000 });
    const at = Date.now();
    await app.evaluate(
      ({ BrowserWindow }, { seats, signals }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          for (const e of seats) win.webContents.send("junto:agent-seat-state-changed", e);
          for (const e of signals) win.webContents.send("junto:agent-signal", e);
        }
      },
      { seats: seatEvents(at), signals: signalEvents(at) },
    );
    const seat = page.locator('.react-flow__node[data-id="s5"]');
    await expect(seat.locator('.junto-mark[data-mark-size="seat"]')).toHaveAttribute("data-mark-ring", "done", { timeout: 10_000 });

    for (const theme of ["dark", "bright"] as const) {
      await setTheme(page, theme);
      await page.getByRole("button", { name: /fit all/i }).first().click();
      await page.waitForTimeout(600);
      for (const [tier, zoom] of TIERS) {
        await zoomTo(page, zoom);
        await expect(page.locator("html")).toHaveAttribute("data-canvas-tier", tier);
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${SHOTS}/${theme}-${tier}.png` });

        const look = await seat.evaluate((el) => {
          const line = el.querySelector(".junto-seat__line");
          const mark = el.querySelector('.junto-mark[data-mark-size="seat"]');
          const disc = mark ? getComputedStyle(mark, "::before") : undefined;
          const note = document.querySelector('.react-flow__node[data-id="n0"] .junto-node');
          return {
            line: line ? getComputedStyle(line).display : "missing",
            atlas: mark ? getComputedStyle(mark).backgroundImage !== "none" : false,
            disc: disc ? disc.content !== "none" && disc.content !== "normal" : false,
            noteBody: document.querySelector('.react-flow__node[data-id="n0"] .note-md > :nth-child(2)')
              ? getComputedStyle(document.querySelector('.react-flow__node[data-id="n0"] .note-md > :nth-child(2)')!).display
              : "missing",
            noteVisible: note ? getComputedStyle(note.firstElementChild ?? note).visibility : "missing",
            stamp: document.documentElement.hasAttribute("data-mark-frame"),
            preambles: [...document.querySelectorAll(".react-flow__viewport .junto-preamble")].filter(
              (p) => getComputedStyle(p).display !== "none",
            ).length,
          };
        });
        if (tier === "near") {
          expect(look.line).not.toBe("none");
          expect(look.atlas).toBe(true);
          expect(look.disc).toBe(false);
          expect(look.noteBody).not.toBe("none");
        } else if (tier === "mid") {
          expect(look.line).toBe("none");
          expect(look.atlas).toBe(true);
          expect(look.disc).toBe(false);
          expect(look.noteBody).toBe("none");
          expect(look.stamp).toBe(false);
          expect(look.preambles).toBe(0);
        } else {
          expect(look.atlas).toBe(false);
          expect(look.disc).toBe(true);
          expect(look.noteVisible).toBe("hidden");
          expect(look.stamp).toBe(false);
          expect(look.preambles).toBe(0);
        }
      }
    }
  } finally {
    await junto.close();
  }
});
