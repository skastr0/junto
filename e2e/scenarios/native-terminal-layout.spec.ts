/**
 * Native terminal layout e2e — proves the xterm host fills the focus/dock
 * pane (not a content-sized 80×24 island inside a large black panel).
 *
 * Real LocalSessionHost + node-pty/child_process under the sandboxed HOME.
 * Geometry is asserted from getBoundingClientRect + status cols×rows, not
 * screenshots.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const LABEL = "e2e native term";
const BINDING_ID = "e2e-term-binding-1";

/** Deterministic non-interactive shell — no login profile, stays alive. */
const LAUNCH = {
  kind: "command" as const,
  argv: ["/bin/sh", "-c", "printf 'e2e-native-terminal\\r\\n'; exec sleep 3600"],
};

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
    const surface = document.querySelector(".native-terminal-surface");
    if (!surface) return { ok: false, reason: "no .native-terminal-surface" };
    const host = surface.querySelector(".native-terminal-surface__xterm");
    const xterm = host?.querySelector(".xterm") ?? null;
    const pane = surface.closest(".workbench-pane");
    const panel = surface.closest(".focus-surface__panel") ?? surface.closest(".work-surface-dock");
    const status =
      surface.querySelector(".native-terminal-surface__status")?.textContent?.trim() ?? "";
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

  // Absolute floor — island was often < 200×100 in a 1000×700 panel.
  expect(host.w, `${where}: host width too small (${host.w})`).toBeGreaterThan(400);
  expect(host.h, `${where}: host height too small (${host.h})`).toBeGreaterThan(250);

  // Surface fills outer pane (allow 24px chrome/border slack).
  expect(surface.w, `${where}: surface width vs outer`).toBeGreaterThan(outer.w * 0.92);
  expect(surface.h, `${where}: surface height vs outer`).toBeGreaterThan(outer.h * 0.9);

  // Host fills surface below the 28px status strip.
  expect(host.w, `${where}: host width vs surface`).toBeGreaterThan(surface.w * 0.95);
  expect(host.h, `${where}: host height vs surface`).toBeGreaterThan(surface.h * 0.85);

  // xterm absolute-fill must track the host, not content-size to 80×24.
  if (probe.xterm) {
    expect(probe.xterm.w, `${where}: .xterm width vs host`).toBeGreaterThan(host.w * 0.95);
    expect(probe.xterm.h, `${where}: .xterm height vs host`).toBeGreaterThan(host.h * 0.95);
  }

  // cols×rows must match the host box at ~7.8×15.6 cell (13px mono).
  expect(probe.cols, `${where}: missing cols in status (${probe.status})`).toBeTruthy();
  expect(probe.rows, `${where}: missing rows in status (${probe.status})`).toBeTruthy();
  const cols = probe.cols!;
  const rows = probe.rows!;
  expect(cols, `${where}: cols too small for filled host`).toBeGreaterThanOrEqual(60);
  expect(rows, `${where}: rows too small for filled host`).toBeGreaterThanOrEqual(20);

  const expectedCols = Math.floor((host.w - 16) / 7.8);
  const expectedRows = Math.floor((host.h - 12) / 15.6);
  // Allow generous slack for font metrics / scrollback ruler — but not island-scale error.
  expect(Math.abs(cols - expectedCols), `${where}: cols ${cols} vs ~${expectedCols} from host ${host.w}px`).toBeLessThanOrEqual(18);
  expect(Math.abs(rows - expectedRows), `${where}: rows ${rows} vs ~${expectedRows} from host ${host.h}px`).toBeLessThanOrEqual(10);
};

test.use({
  vellumOptions: {
    seedCanvases: {
      term: canvasDoc([
        terminalTextNode({
          id: "t1",
          bindingId: BINDING_ID,
          label: LABEL,
          launch: LAUNCH,
        }),
      ]),
    },
  },
});

test("native terminal xterm fills focus pane and stays filled after pin", async ({ vellum }) => {
  const { page } = vellum;

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });

  // Start opens the focus surface after create.
  await node.getByRole("button", { name: "Start" }).click();

  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  await expect(surface.locator(".native-terminal-surface__status")).toContainText(/control|attaching/, {
    timeout: 30_000,
  });
  // Wait until geometry label is painted (pushResize ran with a real box).
  await expect
    .poll(async () => {
      const p = await probeLayout(page);
      return p.cols && p.rows && p.host && p.host.w > 400 && p.host.h > 250
        ? `${p.cols}x${p.rows}@${Math.round(p.host.w)}x${Math.round(p.host.h)}`
        : null;
    }, { timeout: 15_000 })
    .toBeTruthy();

  // Let focus-surface enter animation + settle fits finish.
  await page.waitForTimeout(700);

  const focusProbe = await probeLayout(page);
  assertFillsPane(focusProbe, "focus");

  // Pin path was the worst kink — layout reflow must not collapse to island.
  await page.getByRole("button", { name: "Pin all" }).click();
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
  // Pinned dock is narrower — still must fill its pane, not island.
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
});
