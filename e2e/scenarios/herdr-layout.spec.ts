/**
 * Herdr terminal layout e2e — proves the xterm host fills the focus/dock
 * pane (not a content-sized ~80×24 island inside a large black panel).
 *
 * Same geometry contract as native-terminal-layout.spec.ts, against the
 * fake herdr PATH scenario used by herdr-real-pipeline.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneWorkspaceWorld, writeScenario } from "../fakes/scenario";
import { canvasDoc, herdrTextNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

const HOST = "local";
const PANE_ID = "w1:p1";
const TERMINAL_ID = "term_1";
const LABEL = "e2e herdr layout";
const FRAME_TEXT = "herdr-layout-frame\n";

type Box = { x: number; y: number; w: number; h: number };

type LayoutProbe = {
  readonly ok: boolean;
  readonly reason?: string;
  readonly panel?: Box;
  readonly pane?: Box;
  readonly surface?: Box;
  readonly host?: Box;
  readonly xterm?: Box;
  readonly status?: string;
  readonly cols?: number;
  readonly rows?: number;
};

const probeLayout = async (
  page: import("@playwright/test").Page,
): Promise<LayoutProbe> =>
  page.evaluate(() => {
    const box = (el: Element | null | undefined): Box | undefined => {
      if (!el) return undefined;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const surface = document.querySelector(".herdr-terminal-panel");
    if (!surface) return { ok: false, reason: "no .herdr-terminal-panel" };
    const host = surface.querySelector(".herdr-xterm");
    const xterm = host?.querySelector(".xterm") ?? null;
    const pane = surface.closest(".workbench-pane");
    const panel =
      surface.closest(".focus-surface__panel") ?? surface.closest(".work-surface-dock");
    const status =
      surface.querySelector(".herdr-modal-status")?.textContent?.trim() ?? "";
    const geom = status.match(/(\d+)\s*[×x]\s*(\d+)/);
    return {
      ok: true,
      panel: box(panel),
      pane: box(pane),
      surface: box(surface),
      host: box(host),
      xterm: box(xterm),
      status,
      cols: geom ? Number(geom[1]) : undefined,
      rows: geom ? Number(geom[2]) : undefined,
    };
  });

/** Host must fill the pane — the island bug was ~80×24 cells in a huge black box. */
const assertFillsPane = (probe: LayoutProbe, where: string): void => {
  expect(probe.ok, `${where}: ${probe.reason ?? "probe failed"}`).toBe(true);
  expect(probe.host, `${where}: missing host box`).toBeTruthy();
  expect(probe.surface, `${where}: missing surface box`).toBeTruthy();
  expect(probe.pane ?? probe.panel, `${where}: missing pane/panel`).toBeTruthy();

  const host = probe.host!;
  const surface = probe.surface!;
  const outer = probe.pane ?? probe.panel!;

  expect(host.w, `${where}: host width too small (${host.w})`).toBeGreaterThan(400);
  expect(host.h, `${where}: host height too small (${host.h})`).toBeGreaterThan(250);

  expect(surface.w, `${where}: surface width vs outer`).toBeGreaterThan(outer.w * 0.92);
  expect(surface.h, `${where}: surface height vs outer`).toBeGreaterThan(outer.h * 0.85);

  expect(host.w, `${where}: host width vs surface`).toBeGreaterThan(surface.w * 0.95);
  expect(host.h, `${where}: host height vs surface`).toBeGreaterThan(surface.h * 0.8);

  if (probe.xterm) {
    expect(probe.xterm.w, `${where}: .xterm width vs host`).toBeGreaterThan(host.w * 0.95);
    expect(probe.xterm.h, `${where}: .xterm height vs host`).toBeGreaterThan(host.h * 0.95);
  }

  expect(probe.cols, `${where}: missing cols in status (${probe.status})`).toBeTruthy();
  expect(probe.rows, `${where}: missing rows in status (${probe.status})`).toBeTruthy();
  const cols = probe.cols!;
  const rows = probe.rows!;
  expect(cols, `${where}: cols too small for filled host`).toBeGreaterThanOrEqual(60);
  expect(rows, `${where}: rows too small for filled host`).toBeGreaterThanOrEqual(20);

  const expectedCols = Math.floor((host.w - 16) / 7.8);
  const expectedRows = Math.floor((host.h - 12) / 15.6);
  expect(Math.abs(cols - expectedCols), `${where}: cols ${cols} vs ~${expectedCols} from host ${host.w}px`).toBeLessThanOrEqual(18);
  expect(Math.abs(rows - expectedRows), `${where}: rows ${rows} vs ~${expectedRows} from host ${host.h}px`).toBeLessThanOrEqual(10);
};

test("herdr xterm fills focus pane and stays filled after pin", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-command-e2e-herdr-layout-"));
  const scenarioPath = join(scenarioDir, "scenario.json");

  await writeScenario(scenarioPath, {
    world: oneWorkspaceWorld(),
    frames: {
      [TERMINAL_ID]: [{ text: FRAME_TEXT }],
    },
  });

  const fixtureDoc = canvasDoc([
    herdrTextNode({
      id: "h1",
      host: HOST,
      paneId: PANE_ID,
      terminalId: TERMINAL_ID,
      label: LABEL,
    }),
  ]);

  const vellumCommand = await launchVellum({
    extraEnv: { FAKE_HERDR_SCENARIO: scenarioPath },
  });

  try {
    const { page } = vellumCommand;

    // Authority-only boot: disk seedCanvases no longer admit into live map.
    // Install the fixture through the app write path after boot settles.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const runtime = globalThis as unknown as {
              readonly vellumCommand?: {
                readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
              };
            };
            return Boolean(runtime.vellumCommand);
          }),
        { timeout: 30_000 },
      )
      .toBe(true);

    await page.evaluate(async (doc) => {
      const runtime = globalThis as unknown as {
        readonly vellumCommand: {
          readonly listCanvases: () => Promise<ReadonlyArray<{ name: string }>>;
          readonly createCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly readCanvas: (name: string) => Promise<{ name: string; revision: string }>;
          readonly writeCanvas: (
            name: string,
            doc: unknown,
            expectedRevision?: string,
          ) => Promise<unknown>;
        };
      };
      const api = runtime.vellumCommand;
      let list = await api.listCanvases();
      let name = list[0]?.name;
      if (!name) {
        const created = await api.createCanvas("herdrlayout");
        name = created.name;
      }
      const read = await api.readCanvas(name);
      await api.writeCanvas(name, doc, read.revision);
    }, fixtureDoc);

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();

    const surface = page.locator(".herdr-terminal-panel");
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await expect(surface.getByRole("status", { name: "connected" })).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(async () => {
        const p = await probeLayout(page);
        return p.cols && p.rows && p.host && p.host.w > 400 && p.host.h > 250
          ? `${p.cols}x${p.rows}@${Math.round(p.host.w)}x${Math.round(p.host.h)}`
          : null;
      }, { timeout: 15_000 })
      .toBeTruthy();

    // Focus-surface enter animation + settle fits.
    await page.waitForTimeout(700);

    const focusProbe = await probeLayout(page);
    assertFillsPane(focusProbe, "focus");

    // Pin path reflows — must not collapse to island.
    // Terminal/herdr focus has no dock chrome; Pin is surface-local.
    await page.getByRole("button", { name: "Pin" }).click();
    await expect(page.getByLabel("Pinned work surface dock")).toBeVisible({ timeout: 10_000 });
    await expect(surface).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(async () => {
        const p = await probeLayout(page);
        return p.cols && p.host && p.host.w > 300 && p.host.h > 200
          ? `${p.cols}x${p.rows}@${Math.round(p.host.w)}x${Math.round(p.host.h)}`
          : null;
      }, { timeout: 15_000 })
      .toBeTruthy();

    await page.waitForTimeout(500);
    const pinnedProbe = await probeLayout(page);
    expect(pinnedProbe.host, "pinned: host").toBeTruthy();
    expect(pinnedProbe.host!.w, "pinned: host width").toBeGreaterThan(280);
    expect(pinnedProbe.host!.h, "pinned: host height").toBeGreaterThan(200);
    expect(pinnedProbe.cols, "pinned: cols").toBeGreaterThanOrEqual(40);
    expect(pinnedProbe.rows, "pinned: rows").toBeGreaterThanOrEqual(12);

    if (pinnedProbe.pane && pinnedProbe.surface) {
      expect(pinnedProbe.surface.w).toBeGreaterThan(pinnedProbe.pane.w * 0.9);
      expect(pinnedProbe.surface.h).toBeGreaterThan(pinnedProbe.pane.h * 0.9);
    }
    if (pinnedProbe.xterm && pinnedProbe.host) {
      expect(pinnedProbe.xterm.w).toBeGreaterThan(pinnedProbe.host.w * 0.95);
      expect(pinnedProbe.xterm.h).toBeGreaterThan(pinnedProbe.host.h * 0.95);
    }
  } finally {
    await vellumCommand.close();
  }
});
