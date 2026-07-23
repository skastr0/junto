/**
 * Marketing-shots capture — NOT a correctness spec. Composes a staged,
 * product-true board (three regions, two hosts, varied fleet statuses via the
 * demo engine) and captures marketing-grade frames to
 * test-results/marketing-shots/ for the landing site and store plates.
 *   bun run test:e2e:fast e2e/scenarios/marketing-shots.spec.ts
 * The screenshots are the artifact; assertions only prove surfaces appeared.
 * All fleet state is scripted (VELLUM_DEMO=1 + demoCommand) — no wall-clock
 * scenario, so every frame is reproducible.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { demoCommand } from "../harness/demo";
import {
  a2aTask,
  artifactsNode,
  canvasDoc,
  herdrTextNode,
  projectNode,
  requestsNode,
  tasksCriteriaEdge,
  tasksNode,
} from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type { CanvasEdge, CanvasNode, GroupNode } from "../../src/shared/canvas";
import type { DemoHerdrStatus } from "../../src/shared/demo";

// Playwright wipes test-results/ on every run (any spec, any agent) — point
// MARKETING_SHOTS_DIR somewhere durable when the frames matter.
const SHOTS = process.env.MARKETING_SHOTS_DIR ?? join(process.cwd(), "test-results", "marketing-shots");

// Window sized for 16:10 marketing frames; on a Retina display captures land
// at 2x (3520x2200) which is what the landing plates want.
const FRAME = { width: 1760, height: 1100 };

interface FleetPane {
  readonly id: string;
  readonly host: string;
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string;
  readonly label: string;
  readonly status: DemoHerdrStatus;
  readonly x: number;
  readonly y: number;
}

// Hosts split local / remote-a so the multi-host story is visible on cards.
const fleet: readonly FleetPane[] = [
  { id: "h1", host: "local", paneId: "w1:p01", terminalId: "term-p01", agent: "claude", label: "vellum · typecheck", status: "working", x: 0, y: 0 },
  { id: "h2", host: "remote-a", paneId: "w1:p02", terminalId: "term-p02", agent: "codex", label: "ssh kernel", status: "working", x: 300, y: 0 },
  { id: "h3", host: "local", paneId: "w1:p03", terminalId: "term-p03", agent: "kimi", label: "canvas sync", status: "done", x: 600, y: 0 },
  { id: "h4", host: "remote-a", paneId: "w1:p04", terminalId: "term-p04", agent: "opencode", label: "release notes", status: "idle", x: 0, y: 180 },
  { id: "h5", host: "local", paneId: "w1:p05", terminalId: "term-p05", agent: "claude", label: "landing copy pass", status: "working", x: 0, y: 580 },
  { id: "h6", host: "local", paneId: "w1:p06", terminalId: "term-p06", agent: "hermes", label: "og plates", status: "blocked", x: 300, y: 580 },
  { id: "h7", host: "remote-a", paneId: "w1:p07", terminalId: "term-p07", agent: "codex", label: "quasar mining", status: "working", x: 940, y: 580 },
  { id: "h8", host: "local", paneId: "w1:p08", terminalId: "term-p08", agent: "claude", label: "session digests", status: "done", x: 940, y: 760 },
];

const regions: readonly GroupNode[] = [
  { id: "rg-forge", type: "group", label: "forge · build lane", x: -80, y: -80, width: 1220, height: 460, ether: { region: { hold: true } } },
  { id: "rg-beacon", type: "group", label: "beacon · launch", x: -80, y: 500, width: 940, height: 440, ether: { region: { hold: true } } },
  { id: "rg-research", type: "group", label: "deep research", x: 880, y: 500, width: 660, height: 440, ether: { region: { hold: true } } },
];

const notes: readonly CanvasNode[] = [
  {
    id: "note-brief",
    type: "text",
    text: "# Launch week\n\n- landing copy pass\n- og plates\n- founder pricing call\n- ship the beta build",
    x: 1280, y: 0, width: 260, height: 200,
  },
  {
    id: "note-blocker",
    type: "text",
    text: "paddle verification pending",
    x: 0, y: 760, width: 230, height: 84,
    color: "1",
    ether: { flags: ["blocker"] },
  },
  {
    id: "note-attn",
    type: "text",
    text: "copy review pending",
    x: 1200, y: 580, width: 220, height: 80,
    ether: { flags: ["attention"] },
  },
];

const nodes: readonly CanvasNode[] = [
  ...regions,
  ...fleet.map((p) =>
    herdrTextNode({ id: p.id, host: p.host, paneId: p.paneId, terminalId: p.terminalId, label: p.label, x: p.x, y: p.y }),
  ),
  tasksNode({
    id: "tasks-forge",
    x: 300, y: 180,
    items: [a2aTask("t-1", "ship design tokens", "working"), a2aTask("t-2", "wire founder checkout", "submitted")],
  }),
  projectNode({ id: "proj-vellum", name: "vellum", x: 680, y: 190 }),
  requestsNode({
    id: "req-beacon",
    x: 600, y: 580,
    items: [a2aTask("r-1", "approve founder pricing", "input-required")],
  }),
  artifactsNode({ id: "art-beacon", x: 300, y: 760 }),
  projectNode({ id: "proj-launch", name: "launch", x: 600, y: 770 }),
  ...notes,
];

const edges: readonly CanvasEdge[] = [
  tasksCriteriaEdge("e-criteria", "tasks-forge", "proj-vellum"),
  { id: "e-depends", fromNode: "proj-vellum", toNode: "proj-launch", fromSide: "bottom", toSide: "top", ether: { kind: "depends" } },
  { id: "e-blocks", fromNode: "note-blocker", toNode: "proj-launch", fromSide: "right", toSide: "left", ether: { kind: "blocks" } },
  { id: "e-relates", fromNode: "h7", toNode: "note-attn", fromSide: "right", toSide: "left", ether: { kind: "relates" } },
];

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false, animations: "disabled" });
};

test("compose a staged fleet board and capture marketing frames", async () => {
  await mkdir(SHOTS, { recursive: true });

  const vellum = await launchVellum({
    demo: true,
    seedCanvases: { portfolio: canvasDoc(nodes, edges) },
  });

  try {
    const { app, page } = vellum;

    // Marketing frame size — the default 1320x900 window is too tight for a
    // hero plate. Resize before any capture so layout settles once.
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.setSize(size.width, size.height);
        win.center();
      }
    }, FRAME);
    await page.emulateMedia({ reducedMotion: "reduce" });

    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });

    // Light the fleet: scripted mirror transport per host, same pipeline real
    // herdr status uses. Statuses are set synchronously — no timers to race.
    for (const p of fleet) {
      const result = await demoCommand(page, {
        kind: "ensure-pane",
        pane: { host: p.host, paneId: p.paneId, agent: p.agent, label: p.label, cwd: "~/Projects/vellum" },
        status: p.status,
      });
      expect(result.ok, `ensure-pane ${p.paneId} on ${p.host}`).toBe(true);
    }

    // The demo HUD chip is film-set chrome, not product UI — keep it out of
    // marketing frames.
    await page
      .getByText("DEMO · F9 to roll", { exact: false })
      .evaluate((el) => {
        const chip = el.parentElement;
        if (chip) chip.style.display = "none";
      })
      .catch(() => undefined);

    const fit = page.getByRole("button", { name: /fit all/i });
    if (await fit.isVisible().catch(() => false)) await fit.click();
    await page.waitForTimeout(1200);

    // Inventory what actually rendered — catches stowaway nodes in review.
    const inventory = await page.$$eval(".react-flow__node", (els) =>
      els.map((el) => `${el.getAttribute("data-id")} :: ${(el.textContent ?? "").slice(0, 60).replace(/\n/g, " ")}`),
    );
    console.log("BOARD NODES:\n" + inventory.join("\n"));

    // 01 — the hero plate: whole staged board, fleet lit, statuses varied.
    await shot(page, "01-hero-board");

    // Card closeups for detached compositions (element shots, transparent of
    // window chrome). Blocked card pulses — animations stay disabled.
    const closeup = async (hasText: string, name: string) => {
      const el = page.locator(".react-flow__node", { hasText }).first();
      await el.scrollIntoViewIfNeeded();
      await el.screenshot({ path: join(SHOTS, `${name}.png`), animations: "disabled" });
    };
    await closeup("vellum · typecheck", "02-card-working");
    await closeup("og plates", "03-card-blocked");
    await closeup("canvas sync", "04-card-done");
    await closeup("ship design tokens", "05-card-tasks");
    await closeup("approve founder pricing", "06-card-requests");
    await closeup("Launch week", "07-card-note");

    // Chrome closeups: minimap (strategic) and the RTS bottom bar (operational).
    const minimap = page.locator(".rts-minimap-wrap");
    if (await minimap.isVisible().catch(() => false)) {
      await minimap.screenshot({ path: join(SHOTS, "08-minimap.png"), animations: "disabled" });
    }
    const bar = page.locator(".rts-bar-panel");
    if (await bar.isVisible().catch(() => false)) {
      await bar.screenshot({ path: join(SHOTS, "09-rts-bar.png"), animations: "disabled" });
    }

    // 10 — selection state: a working card selected, command panel live.
    await page.locator(".react-flow__node", { hasText: "vellum · typecheck" }).first().click();
    await shot(page, "10-board-selected");
  } finally {
    await vellum.close();
  }
});
