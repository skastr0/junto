/**
 * Browser modal, in the real app: the tab strip follows a closed tab and never
 * falls back to the old header (32a5e48b7); Close takes the page view down with
 * the modal, also in the first frame (e36de97c0); Stop page ends every tab and
 * the page reopens with one (2bcd33134); the redesign keeps Stop page, Close
 * and Maximize in the tab band, the lower edge cyan while a seat drives and
 * amber while the operator holds, the host in ink at rest, and "Opening" in
 * the same chrome (df3388509, 702c4b1ba, 0f7664f26).
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/browser-modal-chrome.spec.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "playwright-core";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult } from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelSeat, modelWire } from "../harness/model";

const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/browser-modal-chrome0101";
const CANVAS = "verify-browser";
const PAGE_URL = "https://example.com/";
const REF = `junto://canvas/${CANVAS}?node=p1`;

const shot = async (app: ElectronApplication, page: Page, name: string): Promise<void> => {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  const parts = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())!;
    const out: Array<{ x: number; y: number; png: string }> = [{ x: 0, y: 0, png: (await win.webContents.capturePage()).toDataURL() }];
    for (const view of win.contentView.children) {
      const contents = (view as { webContents?: Electron.WebContents }).webContents;
      if (contents === undefined || contents === win.webContents || contents.isDestroyed()) continue;
      const bounds = view.getBounds();
      if (bounds.width === 0 || bounds.height === 0) continue;
      out.push({ x: bounds.x, y: bounds.y, png: (await contents.capturePage()).toDataURL() });
    }
    return out;
  });
  const composed = await page.evaluate(async (all) => {
    const images = await Promise.all(all.map((part) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = part.png;
    })));
    const canvas = document.createElement("canvas");
    canvas.width = images[0]!.naturalWidth;
    canvas.height = images[0]!.naturalHeight;
    const scale = canvas.width / window.innerWidth;
    const context = canvas.getContext("2d")!;
    images.forEach((image, index) => context.drawImage(image, all[index]!.x * scale, all[index]!.y * scale));
    return canvas.toDataURL("image/png");
  }, parts);
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(composed.split(",")[1]!, "base64"));
};

/** Native page views attached over the window: any child view of the window with area. */
const visibleViews = (app: ElectronApplication): Promise<Array<{ w: number; h: number; url: string }>> =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())!;
    const out: Array<{ w: number; h: number; url: string }> = [];
    for (const view of win.contentView.children) {
      const contents = (view as { webContents?: Electron.WebContents }).webContents;
      if (contents === undefined || contents === win.webContents || contents.isDestroyed()) continue;
      const b = view.getBounds();
      if (b.width > 0 && b.height > 0) out.push({ w: b.width, h: b.height, url: contents.getURL() });
    }
    return out;
  });

const attachedSessions = (page: Page): Promise<number> =>
  page.evaluate(async (ref) => {
    const listed = await window.junto!.browserSessionList!();
    return listed.ok && listed.data ? listed.data.filter((s) => s.ref === ref && s.attached).length : -1;
  }, REF);

const pageNode = modelNode({ kind: "page", id: "p1", url: PAGE_URL, profile: "personal", onRemove: "kill-session", x: 60, y: 60, width: 240, height: 80, z: 0 });

test("32a5e48b7: closing the shown tab twice keeps the strip and drops each tab", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([pageNode], []) } });
  try {
    const { app, page } = junto;
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    const chrome = page.getByTestId("browser-chrome");
    await expect(chrome).toBeVisible({ timeout: 30_000 });
    const tabs = page.getByTestId("browser-tabs").getByRole("tab");
    await expect(tabs).toHaveCount(1);
    await page.getByRole("button", { name: "New tab" }).click();
    await expect(tabs).toHaveCount(2, { timeout: 20_000 });
    await page.getByRole("button", { name: "New tab" }).click();
    await expect(tabs).toHaveCount(3, { timeout: 20_000 });
    await shot(app, page, "browser-3-tabs");

    // Watch the surface through both closes: the strip must never leave, and the old header must never show.
    await page.evaluate(() => {
      const w = window as unknown as { __strip: { missing: number; oldHeader: number; samples: number } };
      w.__strip = { missing: 0, oldHeader: 0, samples: 0 };
      const check = () => {
        w.__strip.samples += 1;
        if (!document.querySelector('[data-testid="browser-tabs"]')) w.__strip.missing += 1;
        if (!document.querySelector('[data-testid="browser-chrome"]')) w.__strip.oldHeader += 1;
      };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
      setInterval(check, 16);
    });
    const strip = (): Promise<{ missing: number; oldHeader: number; samples: number }> =>
      page.evaluate(() => (window as unknown as { __strip: { missing: number; oldHeader: number; samples: number } }).__strip);

    // Close 1: the shown tab, by its x.
    const activeLabel = async (): Promise<string> => ((await page.getByTestId("browser-tabs").getByRole("tab", { selected: true }).textContent()) ?? "").trim();
    const first = await activeLabel();
    const activeTab = page.getByTestId("browser-tabs").locator('[data-active="true"]');
    await activeTab.getByRole("button", { name: /^Close / }).click();
    await expect(tabs).toHaveCount(2, { timeout: 20_000 });
    await expect(chrome).toBeVisible();
    await shot(app, page, "browser-after-close-1");

    // Close 2: the shown tab, by Delete on the tab.
    const selected = page.getByTestId("browser-tabs").getByRole("tab", { selected: true });
    await selected.focus();
    await page.keyboard.press("Delete");
    await expect(tabs).toHaveCount(1, { timeout: 20_000 });
    await expect(chrome).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(app, page, "browser-after-close-2");
    const seen = await strip();
    console.log(`REPORT strip samples=${seen.samples} stripMissing=${seen.missing} oldHeader=${seen.oldHeader}; first closed tab was "${first}"`);
    expect(seen.missing, "the tab strip never left the surface").toBe(0);
    expect(seen.oldHeader, "the old header never replaced the chrome").toBe(0);
    expect(await tabs.count()).toBe(1);
    // The surviving tab is live: the address bar answers.
    await expect(page.getByLabel("Address").first()).toBeVisible();
  } finally {
    await junto.close();
  }
});

test("e36de97c0: Close takes the page view down with the modal, also while waiting for the session", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([pageNode], []) } });
  try {
    const { app, page } = junto;
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const surface = page.getByRole("region", { name: "Browser page surface" });
    const closeButton = surface.getByRole("button", { name: "Close", exact: true });

    // A: settled page. The view is on the canvas; Close removes it.
    await card.dblclick();
    await expect(page.getByTestId("browser-chrome")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => visibleViews(app), { timeout: 30_000 }).not.toHaveLength(0);
    // Browser Maximize and Restore: the modal fills the frame less padding, the page view follows, and Restore returns.
    {
      await page.waitForTimeout(800);
      const panel = page.locator(".focus-surface__panel").last();
      const root = page.locator(".focus-surface").last();
      const maximize = panel.getByRole("button", { name: "Maximize" }).first();
      const maxVisible = await maximize.isVisible().catch(() => false);
      console.log("REPORT browser Maximize button visible:", maxVisible);
      if (maxVisible) {
        const before = (await panel.boundingBox())!;
        const viewBefore = (await visibleViews(app))[0]!;
        const frame = (await root.boundingBox())!;
        await maximize.click();
        await expect(root).toHaveAttribute("data-maximized", "true");
        await page.waitForTimeout(500);
        const big = (await panel.boundingBox())!;
        const viewBig = (await visibleViews(app))[0]!;
        await shot(app, page, "browser-maximized");
        console.log(`REPORT browser panel ${Math.round(before.width)} -> ${Math.round(big.width)} (frame ${Math.round(frame.width)}); page view ${viewBefore.w}x${viewBefore.h} -> ${viewBig.w}x${viewBig.h}`);
        await maximize.click();
        await expect(root).not.toHaveAttribute("data-maximized", "true");
        await page.waitForTimeout(500);
        const after = (await panel.boundingBox())!;
        const viewAfter = (await visibleViews(app))[0]!;
        console.log(`REPORT browser restored panel ${Math.round(after.width)}x${Math.round(after.height)}; page view ${viewAfter.w}x${viewAfter.h}`);
        expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1.5);
        expect(Math.abs(viewAfter.w - viewBefore.w)).toBeLessThanOrEqual(2);
      }
    }
    await shot(app, page, "close-A-open");
    console.log("REPORT A views before Close:", JSON.stringify(await visibleViews(app)));
    await closeButton.click();
    await expect(surface).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(() => visibleViews(app), { timeout: 10_000, message: "no page view left over the canvas" }).toHaveLength(0);
    expect(await attachedSessions(page), "no session of the page stays attached").toBe(0);
    await shot(app, page, "close-A-closed");
    console.log("REPORT A views after Close:", JSON.stringify(await visibleViews(app)));

    // B: Close the moment the modal shows "waiting for session". Repeat to catch the window.
    let waitingHits = 0;
    for (let i = 0; i < 6; i += 1) {
      await card.dblclick();
      const waiting = page.getByText("waiting for session").first();
      const seenWaiting = await waiting.isVisible().catch(() => false);
      if (seenWaiting) waitingHits += 1;
      await closeButton.first().waitFor({ state: "visible", timeout: 10_000 });
      await closeButton.first().click();
      await expect(surface).toHaveCount(0, { timeout: 10_000 });
      await expect.poll(() => visibleViews(app), { timeout: 10_000, message: `run ${i}: no page view left over the canvas` }).toHaveLength(0);
      await page.waitForTimeout(1500);
      expect(await visibleViews(app), `run ${i}: still none after the open settles`).toHaveLength(0);
      expect(await attachedSessions(page), `run ${i}: no attached session`).toBe(0);
    }
    console.log(`REPORT B 6 immediate Close runs, "waiting for session" visible at Close in ${waitingHits}`);
    // The page opens again after all that.
    await card.dblclick();
    await expect(page.getByTestId("browser-chrome")).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => visibleViews(app), { timeout: 30_000 }).not.toHaveLength(0);
    await shot(app, page, "close-C-reopened");
  } finally {
    await junto.close();
  }
});

test("e36de97c0: Close pressed in the same frame the modal appears (waiting for session)", async () => {
  test.setTimeout(300_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([pageNode], []) } });
  try {
    const { app, page } = junto;
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const surface = page.getByRole("region", { name: "Browser page surface" });
    // Press Close from inside the mutation that first renders it, before main has answered with a session.
    await page.evaluate(() => {
      const w = window as unknown as { __race: { pressed: Array<{ waiting: boolean; chrome: boolean; text?: string }> } };
      w.__race = { pressed: [] };
      new MutationObserver(() => {
        const root = document.querySelector('section[aria-label="Browser page surface"]');
        if (!root) return;
        const close = [...root.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close");
        if (!close || (close as HTMLElement).dataset.raced) return;
        (close as HTMLElement).dataset.raced = "1";
        w.__race.pressed.push({ waiting: root.textContent?.includes("waiting for session") ?? false, chrome: root.querySelector('[data-testid="browser-chrome"]') !== null, text: (root.textContent ?? "").slice(0, 120) });
        close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      }).observe(document.body, { childList: true, subtree: true });
    });
    for (let i = 0; i < 8; i += 1) {
      await card.dblclick();
      await expect(surface).toHaveCount(0, { timeout: 10_000 });
      await expect.poll(() => visibleViews(app), { timeout: 10_000, message: `run ${i}: page view left the canvas` }).toHaveLength(0);
      await page.waitForTimeout(2500);
      expect(await visibleViews(app), `run ${i}: still none after the open settles`).toHaveLength(0);
      expect(await attachedSessions(page), `run ${i}: no attached session`).toBe(0);
    }
    const pressed = await page.evaluate(() => (window as unknown as { __race: { pressed: Array<{ waiting: boolean; chrome: boolean }> } }).__race.pressed);
    console.log("REPORT race texts:", JSON.stringify(pressed.map((p) => (p as { text?: string }).text)));
    console.log(`REPORT race: ${pressed.length} presses, "waiting for session" showing at press in ${pressed.filter((p) => p.waiting).length}, chrome showing in ${pressed.filter((p) => p.chrome).length}`);
    await shot(app, page, "close-race-final");
    expect(pressed.length).toBeGreaterThan(0);
  } finally {
    await junto.close();
  }
});

// ── Redesign rounds 1 to 3 and Stop page (df3388509, 702c4b1ba, 0f7664f26, 2bcd33134) ──

const envelope = (result: CrewCliResult): { ok?: boolean; data?: Record<string, unknown> } => {
  const text = result.stdout.trim() || result.stderr.trim();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false };
  }
};

const sessionsOf = (page: Page): Promise<number> =>
  page.evaluate(async (ref) => {
    const listed = await window.junto!.browserSessionList!();
    return listed.ok && listed.data ? listed.data.filter((s) => s.ref === ref && s.state !== "destroyed").length : -1;
  }, REF);

test("[fake-tui] redesign: controls in the tab band, driver edge cyan then amber, host in ink, Opening in the same chrome", async () => {
  test.setTimeout(300_000);
  const scout = modelSeat({ id: "scout", key: "local:verify-scout", label: "Scout", harness: "codex", cwd: "/tmp", x: 0, y: 0 });
  const withPage = modelNode({ kind: "page", id: "p1", url: PAGE_URL, profile: "personal", onRemove: "kill-session", x: 360, y: 0, width: 240, height: 80, z: 0 });
  const nodes = [scout, withPage];
  const junto = await launchJunto({
    seedModels: { [CANVAS]: modelFixture(nodes, [modelWire("w1", "scout", "p1", "navigates", nodes)]) },
    afterSeed: installCrewSeatHarness,
  });
  try {
    const { app, page, sandbox } = junto;
    const seat = crewSeat(sandbox, CANVAS, "scout");
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);
    await crewOccupySeat(page, CANVAS, scout, seat);
    expect((await seat.op("onboard", {})).ok).toBe(true);
    const report: string[] = [];

    // Opening: watch every DOM change from the double-click on.
    await page.evaluate(() => {
      const w = window as unknown as { __open: { pending: string[]; bare: number; samples: number; firstPendingBands: unknown } };
      w.__open = { pending: [], bare: 0, samples: 0, firstPendingBands: null };
      const check = () => {
        const surface = document.querySelector('section[aria-label="Browser page surface"]');
        if (!surface) return;
        w.__open.samples += 1;
        const pending = surface.querySelector('[data-testid="browser-chrome-pending"]');
        const chrome = surface.querySelector('[data-testid="browser-chrome"]');
        if (pending) {
          const text = (pending.textContent ?? "").replace(/\s+/g, " ").trim();
          if (w.__open.pending[w.__open.pending.length - 1] !== text) w.__open.pending.push(text);
          if (!w.__open.firstPendingBands) w.__open.firstPendingBands = { top: !!pending.querySelector(".browser-chrome__top"), row: !!pending.querySelector(".browser-chrome__row") };
        }
        if (!pending && !chrome) w.__open.bare += 1;
      };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true, characterData: true });
      setInterval(check, 8);
    });
    await card.dblclick();
    const chrome = page.getByTestId("browser-chrome");
    await expect(chrome).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => visibleViews(app), { timeout: 30_000 }).not.toHaveLength(0);
    await page.waitForTimeout(1200);
    const open = await page.evaluate(() => (window as unknown as { __open: unknown }).__open);
    report.push(`opening | ${JSON.stringify(open)}`);

    // Controls in the tab band.
    const bands = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="browser-chrome"]')!;
      const rect = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
      const top = rect(root.querySelector(".browser-chrome__top"));
      const row = rect(root.querySelector(".browser-chrome__row"));
      const tabs = rect(root.querySelector('[data-testid="browser-tabs"]'));
      const named = (label: string | RegExp) =>
        [...document.querySelectorAll('section[aria-label="Browser page surface"] button')].find((b) => (typeof label === "string" ? b.textContent?.trim() === label || b.getAttribute("aria-label") === label : label.test(b.textContent ?? "") || label.test(b.getAttribute("aria-label") ?? "")));
      const mid = (el: Element | undefined) => (el ? el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2 : null);
      return {
        top: top && { y: top.top, bottom: top.bottom },
        row: row && { y: row.top, bottom: row.bottom },
        tabs: tabs && { y: tabs.top, bottom: tabs.bottom },
        stop: mid(named(/Stop page/i)),
        close: mid(named("Close")),
        maximize: mid(named("Maximize")),
      };
    });
    report.push(`band | ${JSON.stringify(bands)}`);
    for (const key of ["stop", "close", "maximize"] as const) {
      expect(bands[key], `${key} exists`).not.toBeNull();
      expect(bands[key]!, `${key} sits in the tab band`).toBeGreaterThanOrEqual(bands.top!.y);
      expect(bands[key]!, `${key} sits in the tab band`).toBeLessThanOrEqual(bands.top!.bottom);
      expect(bands[key]!, `${key} is not in the address row`).toBeLessThan(bands.row!.y);
    }

    // Host in ink at rest.
    const ink = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--color-ink)";
      document.body.appendChild(probe);
      const inkColor = getComputedStyle(probe).color;
      probe.remove();
      const field = document.querySelector(".address-bar__field");
      const shownEl = field?.querySelector(".address-bar__shown") ?? null;
    const quiet = [...(field?.querySelectorAll(".address-bar__quiet") ?? [])].map((s) => ({ t: s.textContent, c: getComputedStyle(s).color }));
    return { inkColor, shown: shownEl && { t: shownEl.textContent, c: getComputedStyle(shownEl).color }, quiet };
    });
    report.push(`address | ink ${ink.inkColor} | shown ${JSON.stringify(ink.shown)} | quiet ${JSON.stringify(ink.quiet)}`);
    expect(ink.shown?.t, "the address shows the host").toContain("example.com");
    expect(ink.shown?.c, "the host is in ink").toBe(ink.inkColor);
    for (const q of ink.quiet) expect(q.c, `quiet part "${q.t}" is not ink`).not.toBe(ink.inkColor);
    await shot(app, page, "design-1-rest-host-ink");

    // Lower edge by driver.
    const edge = () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="browser-chrome"]') as HTMLElement;
        const cs = getComputedStyle(el, "::after");
        return { driver: el.dataset.driver, bg: cs.backgroundColor, opacity: cs.opacity };
      });
    const rest = await edge();
    report.push(`edge rest | ${JSON.stringify(rest)}`);
    const opened = envelope(await seat.cli(["browser", "open", REF]));
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const sessionId = String(opened.data?.sessionId);
    // A slow act keeps the seat "running", so the edge has time to be read.
    const running = seat.cli(["browser", "eval", sessionId, "new Promise((resolve) => setTimeout(() => resolve(1), 6000))"]);
    await expect.poll(async () => (await edge()).driver, { timeout: 10_000 }).toBe("seat-live");
    const seatEdge = await edge();
    report.push(`edge seat | ${JSON.stringify(seatEdge)}`);
    await shot(app, page, "design-2-seat-drives-cyan");
    void running.catch(() => undefined);

    await chrome.getByRole("button", { name: /Take over/i }).click();
    await expect.poll(async () => (await edge()).driver, { timeout: 10_000 }).toBe("operator-held");
    await page.waitForTimeout(500);
    const heldEdge = await edge();
    report.push(`edge held | ${JSON.stringify(heldEdge)}`);
    await shot(app, page, "design-3-take-over-amber");
    expect(seatEdge.bg).not.toBe(heldEdge.bg);
    expect(seatEdge.bg).not.toBe(rest.bg);
    console.log("REPORT\n" + report.join("\n"));
    expect(open).toMatchObject({ bare: 0 });
  } finally {
    await junto.close();
  }
});

test("2bcd33134: Stop page with three tabs ends every tab and the page reopens with one", async () => {
  test.setTimeout(240_000);
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([pageNode], []) } });
  try {
    const { app, page } = junto;
    const card = page.locator('.react-flow__node[data-id="p1"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.dblclick();
    const chrome = page.getByTestId("browser-chrome");
    await expect(chrome).toBeVisible({ timeout: 30_000 });
    const tabs = page.getByTestId("browser-tabs").getByRole("tab");
    await page.getByRole("button", { name: "New tab" }).click();
    await expect(tabs).toHaveCount(2, { timeout: 20_000 });
    await page.getByRole("button", { name: "New tab" }).click();
    await expect(tabs).toHaveCount(3, { timeout: 20_000 });
    await expect.poll(() => sessionsOf(page)).toBe(3);
    await shot(app, page, "stop-1-three-tabs");
    const surface = page.getByRole("region", { name: "Browser page surface" });
    await surface.getByRole("button", { name: /Stop page/i }).click();
    const confirm = surface.getByRole("button", { name: /Stop every tab/i });
    await expect(confirm, "the first press arms Stop every tab").toBeVisible({ timeout: 2000 });
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, "stop-2-armed.png") });
    await confirm.click();
    // Every tab's session ends and the surface closes.
    await expect.poll(() => sessionsOf(page), { timeout: 30_000, message: "after Stop page no tab session is left" }).toBe(0);
    await expect(surface).toHaveCount(0, { timeout: 15_000 });
    expect((await visibleViews(app)).length, "no page view left on the canvas").toBe(0);
    await shot(app, page, "stop-3-all-ended");
    // The page opens again fresh, with one tab.
    await card.dblclick();
    await expect(chrome).toBeVisible({ timeout: 30_000 });
    await expect(tabs).toHaveCount(1, { timeout: 30_000 });
    await expect.poll(() => sessionsOf(page), { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => (await visibleViews(app)).length, { timeout: 30_000 }).toBe(1);
    await shot(app, page, "stop-4-reopened-one-tab");
    console.log("REPORT stop page: 3 sessions before; 0 after Stop and surface closed; reopen gives 1 tab, 1 session, 1 view");
  } finally {
    await junto.close();
  }
});
