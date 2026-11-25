/**
 * The top bar and its window drag region. app-region is a darwin behaviour
 * (the bar is `-webkit-app-region: drag` there, and a drag region ignores
 * z-index), so the Linux display cannot prove that a window really stops
 * dragging. What it can prove is the cascade: Chromium computes the same
 * `-webkit-app-region` here, so with the darwin marker set on <html> the bar
 * reads `drag` at rest and `no-drag` while any overlay is open, and `drag`
 * again once it is closed. An always-open dialog or menu in the page would
 * make the bar undraggable for good; the rest line catches that.
 *   bun run test:e2e:fast e2e/scenarios/top-bar-drag.spec.ts
 */
import type { Page } from "@playwright/test";
import { canvasReady } from "../harness/canvas";
import { mod } from "../harness/keys";
import { expect, test } from "../harness/launch";

const appRegion = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.querySelector(".station-bar")!).getPropertyValue("-webkit-app-region").trim());

test("the bar is a drag region at rest and none while an overlay is open", async ({ junto: { page } }) => {
  await canvasReady(page, { timeout: 30_000 });
  // The window sets this from main's platform; the Linux display stands in for the Mac.
  await page.evaluate(() => {
    document.documentElement.dataset.juntoPlatform = "darwin";
  });
  await expect.poll(() => appRegion(page), { message: "the bar at rest" }).toBe("drag");

  // A dialog that crosses the bar: the command bar.
  await page.getByRole("button", { name: /^Search / }).click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
  await expect.poll(() => appRegion(page), { message: "the bar with the command bar open" }).toBe("no-drag");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => appRegion(page), { message: "the bar after it closed" }).toBe("drag");

  // Quick thread, which sits in the bar's band.
  await page.keyboard.press(mod("Shift+U"));
  await expect(page.getByTestId("quick-thread")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => appRegion(page), { message: "the bar with Quick thread open" }).toBe("no-drag");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("quick-thread")).toHaveCount(0);
  await expect.poll(() => appRegion(page), { message: "the bar after Quick thread closed" }).toBe("drag");

  // A listbox that is not the bar's own: the canvas switcher's list.
  await page.getByRole("combobox", { name: "Active canvas" }).or(page.getByLabel("Active canvas")).first().click();
  await expect(page.getByRole("listbox").first()).toBeVisible();
  await expect.poll(() => appRegion(page), { message: "the bar with the canvas list open" }).toBe("no-drag");
  await page.keyboard.press("Escape");
  await expect.poll(() => appRegion(page), { message: "the bar after the list closed" }).toBe("drag");
});

// The wide panels (Threads, Needs you) start under the bar (f184af92e, 52ce4e021): the bar stays a drag region, it never overlaps a panel even in the smallest window, and a press on a bar button does not drop a reply draft.
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness } from "../harness/crew-fixture";
import { modelFixture, modelSeat } from "../harness/model";
import { launchJunto } from "../harness/launch";

test("wide panels start under the bar: drag at rest under them, no overlap at the smallest window, a bar press keeps a reply draft", async () => {
  test.setTimeout(180_000);
  const ada = modelSeat({ id: "seat-ada", label: "Ada", x: 60, y: 120 });
  const CANVAS = "topbardrag";
  const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([ada]) }, afterSeed: installCrewSeatHarness });
  const { page } = junto;
  try {
    await canvasReady(page, { timeout: 30_000 });
    await crewPlayFactory(page);
    const seat = crewSeat(junto.sandbox, CANVAS, ada.id);
    await crewOccupySeat(page, CANVAS, { id: ada.id }, seat);
    const sent = await page.evaluate(async ([canvasName, id]) => window.junto!.seatThreadSend({ canvasName, nodeId: id, text: "Status of the build?" } as never), [CANVAS, ada.id] as const);
    expect(sent.ok).toBe(true);
    if (sent.ok) await seat.op("msg.reply", { target: "operator", inReplyTo: sent.messageId, text: "Green." });
    await new Promise((r) => setTimeout(r, 800));
    await page.evaluate(() => {
      document.documentElement.dataset.juntoPlatform = "darwin";
    });

    const threads = page.getByTestId("threads-trigger");
    const needs = page.getByTestId("operator-feed-trigger");
    const panelTop = (sel: string) => page.locator(sel).first().evaluate((el) => Math.round((el.closest('[role="dialog"]') ?? el).getBoundingClientRect().top));
    const barBottom = () => page.evaluate(() => Math.round(document.querySelector(".station-bar")!.getBoundingClientRect().bottom));

    // (c) the bar reads drag under an open wide panel, and no-drag with the command bar open.
    await threads.click();
    await expect(page.locator(".operator-threads").first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => appRegion(page), { message: "the bar with Threads open" }).toBe("drag");
    await threads.click();
    await needs.click();
    await expect(page.locator(".operator-feed, [data-testid='operator-feed']").first()).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => appRegion(page), { message: "the bar with Needs you open" }).toBe("drag");
    await needs.click();
    await page.getByRole("button", { name: /^Search / }).click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await expect.poll(() => appRegion(page), { message: "the bar with the command bar open" }).toBe("no-drag");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // (a) the smallest window the app allows: the bar's bottom edge against each panel's top.
    const min = await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getMinimumSize());
    const original = await junto.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getSize());
    await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w!, h!), min as [number, number]);
    await new Promise((r) => setTimeout(r, 800));
    const geo: string[] = [];
    for (const [name, trigger, sel] of [["Threads", threads, ".operator-threads"], ["Needs you", needs, ".operator-feed, [data-testid='operator-feed']"]] as const) {
      await trigger.click();
      await expect(page.locator(sel).first()).toBeVisible({ timeout: 10_000 });
      const top = await panelTop(sel);
      const bottom = await barBottom();
      geo.push(`${name}: panel top ${top}px, bar bottom ${bottom}px`);
      await page.keyboard.press("Escape");
      await expect(page.locator(sel)).toHaveCount(0, { timeout: 5_000 });
      expect(top, `${name} at the smallest window (${min.join("x")}): ${geo.join("; ")}`).toBeGreaterThanOrEqual(bottom);
    }
    console.log(`SMALLEST WINDOW ${min.join("x")}: ${geo.join("; ")}`);
    await junto.app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0]!.setSize(w!, h!), original as [number, number]);
    await new Promise((r) => setTimeout(r, 500));

    // (b) a reply draft open in Threads survives a press on a bar button that acts without closing the panel (pause or play), and what a switch to Needs you and back does to it is recorded.
    await threads.click();
    await page.getByTestId("operator-threads-row").filter({ hasText: "Ada" }).first().click();
    const composer = () => page.getByTestId("operator-threads-pane").getByTestId("thread-composer-input");
    await composer().fill("A half-typed reply");
    const pause = page.locator("[data-pause-state]").first();
    const pauseBefore = await pause.getAttribute("aria-label").catch(() => null);
    await pause.click();
    await new Promise((r) => setTimeout(r, 600));
    const afterPress = { panelOpen: (await page.locator(".operator-threads").count()) > 0, draft: await composer().inputValue().catch(() => "(composer gone)"), focus: await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName ?? "") };
    await pause.click();
    await needs.click();
    await expect(page.locator(".operator-feed, [data-testid='operator-feed']").first()).toBeVisible({ timeout: 10_000 });
    await threads.click();
    await expect(page.locator(".operator-threads").first()).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("operator-threads-row").filter({ hasText: "Ada" }).first().click();
    const afterSwitch = await composer().inputValue().catch(() => "(composer gone)");
    console.log(`DRAFT after a press on the bar's "${String(pauseBefore)}" button: ${JSON.stringify(afterPress)}; after Threads to Needs you to Threads: ${JSON.stringify(afterSwitch)}`);
    expect(afterPress.draft, `the reply draft after a bar button press: ${JSON.stringify(afterPress)}; after a switch to Needs you and back: ${JSON.stringify(afterSwitch)}`).toBe("A half-typed reply");
  } finally {
    await junto.close();
  }
});
