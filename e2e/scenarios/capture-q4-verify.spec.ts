/**
 * Real app, 0.11.2 quick capture Inbox (11 Q4), the walk product-settings asked for, dark and bright.
 *
 * (a) On a canvas with no Inbox, the first Cmd+T asks in the right half while the left half still searches,
 *     and a pick opens the editor with focus in it.
 * (b) Settings > Inbox shows the picked node checked, a second pick moves the Inbox, and a new capture lands in it.
 * (c) Make an Inbox adds an Artifacts node named Inbox below the lowest node, outside every region, and sets it.
 * (d) Ask again clears the Inbox, and the next Cmd+T asks.
 * (e) Deleting the Inbox node makes the next Cmd+T ask again.
 * (f) Quit and relaunch keeps the Inbox.
 *
 * The capture editor is the real CaptureEditor from 9bfaf49e6 on. Deleting the Inbox node asks with the native
 * confirm, which the walk answers in page, as canvas-delete-cancel.spec.ts does.
 *   JUNTO_SHOTS_DIR=<dir> bun run test:e2e:fast e2e/scenarios/capture-q4-verify.spec.ts
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelRegion } from "../harness/model";
import { createSandbox } from "../harness/sandbox";

const CANVAS = "capture-q4";
const SHOTS = process.env.JUNTO_SHOTS_DIR ?? "test-results/capture-q4-verify";
const GROUP = "Artifacts node for captures";

const shoot = async (page: Page, name: string): Promise<void> => {
  for (const theme of ["dark", "bright"] as const) {
    mkdirSync(join(SHOTS, theme), { recursive: true });
    await page.evaluate((t) => window.junto!.settingsPatch({ appearance: { theme: t } }), theme);
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, theme, `${name}.png`) });
  }
  await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
};

/** The picker: one radio per Artifacts node, one checked when it is the Inbox. */
const picker = (page: Page): Locator => page.getByRole("radiogroup", { name: GROUP, exact: true });
const askHeading = (page: Page): Locator => page.getByRole("heading", { name: "Where do captures go?", exact: true });
/** The left half's search field: the surface is open when it shows. */
const search = (page: Page): Locator => page.getByLabel("Search every artifact", { exact: true });
const writer = (page: Page): Locator => page.locator("[data-capture-entry] [contenteditable='true'], [data-capture-entry] textarea").first();
const inboxNodes = (page: Page): Locator => page.locator(".react-flow__node").filter({ hasText: "Inbox" });
/** The titles of the artifacts on the Notes node, as the app lists them. */
const notesTitles = (page: Page): Promise<string[]> =>
  page.evaluate(async (canvas) => {
    const heads = (await window.junto!.resource!.artifact!.list(canvas, "notes" as never)) as ReadonlyArray<{ artifact: { title: string } }>;
    return heads.map((head) => head.artifact.title);
  }, CANVAS);

const openSettingsInbox = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Open settings", exact: true }).click();
  await page.locator(".settings-nav__item", { hasText: "Inbox" }).click();
  await expect(picker(page)).toBeVisible({ timeout: 10_000 });
};
const closeSettings = async (page: Page): Promise<void> => {
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(300);
};
/** The focused editor keeps Escape, so focus moves to the search field first; Escape then closes the surface. */
const closeCapture = async (page: Page): Promise<void> => {
  await search(page).click();
  await page.keyboard.press("Escape");
  await expect(search(page)).toBeHidden({ timeout: 5_000 });
};

type Result = { row: string; pass: boolean; detail?: string };

test("quick capture Q4: the first Cmd+T asks for an Inbox, Settings moves it, Make an Inbox adds one below the canvas, Ask again clears it, deleting it asks again, and it survives a relaunch", async () => {
  test.setTimeout(600_000);
  const results: Result[] = [];
  const check = async (row: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ row, pass: true });
    } catch (error) {
      results.push({ row, pass: false, detail: String(error).replace(/\u001b\[[0-9;]*m/gu, "").split("\n").slice(0, 4).join(" ") });
    }
  };
  const seed = modelFixture([
    modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 60, y: 60, width: 260, height: 160, z: 0 }),
    modelNode({ kind: "artifacts", id: "notes", label: "Notes", x: 360, y: 60, width: 260, height: 160, z: 0 }),
    // A region under the nodes: the Inbox must land below the lowest node and outside this region.
    modelRegion({ id: "lab", label: "Lab", x: 40, y: 260, width: 640, height: 200, z: 0 }),
  ]);
  // One sandbox for both launches: a launch that owns its sandbox deletes it on close, and the relaunch needs the state.
  const sandbox = await createSandbox();
  let junto: Awaited<ReturnType<typeof launchJunto>>;
  try {
    junto = await launchJunto({ sandbox, windowContentSize: { width: 1500, height: 900 }, seedModels: { [CANVAS]: seed } });
  } catch (error) {
    console.log("Q4 LAUNCH STACK", (error as Error).stack?.split("\n").slice(0, 12).join(" | "));
    throw error;
  }
  try {
    const { page } = junto;
    await page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(page.locator('.react-flow__node[data-id="shelf"]')).toBeVisible({ timeout: 30_000 });

    // (a) The first Cmd+T asks; the left half still searches; a pick opens the editor, focused.
    await page.keyboard.press("Meta+t");
    await check("(a) the first Cmd+T asks where captures go, in the right half", async () => {
      await expect(askHeading(page)).toBeVisible({ timeout: 10_000 });
      const ask = await askHeading(page).boundingBox();
      const field = await search(page).boundingBox();
      expect(ask?.x ?? 0, "the ask sits right of the search column").toBeGreaterThan((field?.x ?? 0) + (field?.width ?? 0));
    });
    await check("(a) the left half still searches while the ask shows", async () => {
      await search(page).fill("sh");
      await expect(page.getByText(/matches/iu).first()).toBeVisible({ timeout: 5_000 });
      await expect(askHeading(page)).toBeVisible();
    });
    await shoot(page, "1-ask-with-search");
    await check("(a) a pick opens the editor, and the editor takes focus", async () => {
      await picker(page).getByRole("radio", { name: /^Shelf/u }).click();
      await expect(writer(page)).toBeVisible({ timeout: 10_000 });
      await expect(writer(page)).toBeFocused({ timeout: 5_000 });
    });
    await shoot(page, "2-editor-focused");
    await closeCapture(page);

    // (b) Settings > Inbox shows the picked node checked, and a second pick moves it.
    await check("(b) Settings > Inbox shows the picked node checked", async () => {
      await openSettingsInbox(page);
      await expect(picker(page).getByRole("radio", { name: /^Shelf/u })).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
    });
    await check("(b) a second pick moves the Inbox to the other node", async () => {
      await picker(page).getByRole("radio", { name: /^Notes/u }).click();
      await expect(picker(page).getByRole("radio", { name: /^Notes/u })).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
      await expect(picker(page).getByRole("radio", { name: /^Shelf/u })).toHaveAttribute("aria-checked", "false", { timeout: 5_000 });
    });
    // A new capture goes to the picked node: the Inbox is Notes, so the capture lands on Notes.
    await check("(b) a new capture lands in the chosen Inbox", async () => {
      await closeSettings(page);
      await page.keyboard.press("Meta+t");
      await expect(writer(page)).toBeVisible({ timeout: 10_000 });
      await writer(page).click();
      await page.keyboard.type("Q4 capture check");
      await closeCapture(page);
      await expect.poll(() => notesTitles(page), { timeout: 30_000 }).toContain("Q4 capture check");
    });
    await openSettingsInbox(page);
    await shoot(page, "3-settings-inbox-moved");

    // (c) Make an Inbox: an Artifacts node named Inbox below the lowest node, outside the region, and set.
    await check("(c) Make an Inbox adds an Artifacts node named Inbox and sets it", async () => {
      await page.getByRole("button", { name: "Make an Inbox", exact: true }).click();
      await expect(picker(page).getByRole("radio", { name: /^Inbox/u })).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });
      await expect(inboxNodes(page)).toHaveCount(1, { timeout: 10_000 });
    });
    await check("(c) the Inbox sits below the lowest node and outside every region", async () => {
      const inbox = await inboxNodes(page).first().boundingBox();
      const shelf = await page.locator('.react-flow__node[data-id="shelf"]').boundingBox();
      const notes = await page.locator('.react-flow__node[data-id="notes"]').boundingBox();
      const lab = await page.locator('.react-flow__node[data-id="lab"]').boundingBox();
      expect(inbox, "the Inbox node is on the canvas").not.toBeNull();
      const lowest = Math.max((shelf?.y ?? 0) + (shelf?.height ?? 0), (notes?.y ?? 0) + (notes?.height ?? 0));
      expect(inbox!.y, "below the lowest node").toBeGreaterThan(lowest);
      const apart = inbox!.x + inbox!.width <= (lab?.x ?? 0) || inbox!.x >= (lab?.x ?? 0) + (lab?.width ?? 0) || inbox!.y + inbox!.height <= (lab?.y ?? 0) || inbox!.y >= (lab?.y ?? 0) + (lab?.height ?? 0);
      expect(apart, "outside the region").toBe(true);
    });
    await shoot(page, "4-inbox-made");

    // (d) Ask again clears the Inbox; the next Cmd+T asks.
    await check("(d) Ask again clears the Inbox, and the next Cmd+T asks", async () => {
      await page.getByRole("button", { name: "Ask again on the next capture", exact: true }).click();
      await expect(picker(page).locator('[aria-checked="true"]')).toHaveCount(0, { timeout: 5_000 });
      await closeSettings(page);
      await page.keyboard.press("Meta+t");
      await expect(askHeading(page)).toBeVisible({ timeout: 10_000 });
      await closeCapture(page);
    });
    await shoot(page, "5-asks-again");

    // (e) Deleting the Inbox node makes the next Cmd+T ask again. The Inbox is set first, by its radio.
    await check("(e) deleting the Inbox node makes the next Cmd+T ask again", async () => {
      await openSettingsInbox(page);
      await picker(page).getByRole("radio", { name: /^Inbox/u }).click();
      await closeSettings(page);
      // The app asks with native confirm, which Playwright cannot drive (canvas-delete-cancel.spec.ts): answer yes in page.
      await page.evaluate(() => {
        const host = window as unknown as { __asked?: string[] };
        host.__asked = [];
        window.confirm = (message?: string) => {
          host.__asked?.push(message ?? "");
          return true;
        };
      });
      await inboxNodes(page).first().click({ position: { x: 6, y: 6 } });
      const selectedClass = await inboxNodes(page).first().getAttribute("class");
      await page.keyboard.press("Delete");
      await page.waitForTimeout(1_000);
      const afterDelete = await inboxNodes(page).count();
      if (afterDelete > 0) {
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(1_000);
      }
      const asked = await page.evaluate(() => (window as unknown as { __asked?: string[] }).__asked ?? []);
      console.log("Q4 DELETE", JSON.stringify({ selectedClass, afterDelete, asked, nodesLeft: await inboxNodes(page).count() }));
      await shoot(page, "6a-after-backspace");
      await expect(inboxNodes(page)).toHaveCount(0, { timeout: 10_000 });
      await page.keyboard.press("Meta+t");
      await expect(askHeading(page)).toBeVisible({ timeout: 10_000 });
      await closeCapture(page);
    });
    await shoot(page, "6-deleted-asks-again");

    // (f) Set the Inbox to Notes, quit, relaunch on the same home: the Inbox is kept.
    await check("(f) Settings holds the Notes Inbox before the quit", async () => {
      await openSettingsInbox(page);
      await picker(page).getByRole("radio", { name: /^Notes/u }).click();
      await expect(picker(page).getByRole("radio", { name: /^Notes/u })).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
      await closeSettings(page);
    });
    await junto.close();
    junto = await launchJunto({ sandbox, windowContentSize: { width: 1500, height: 900 } });
    await check("(f) after a relaunch, Settings > Inbox still shows Notes checked", async () => {
      const again = junto.page;
      await expect(again.locator('.react-flow__node[data-id="notes"]')).toBeVisible({ timeout: 30_000 });
      await openSettingsInbox(again);
      await expect(picker(again).getByRole("radio", { name: /^Notes/u })).toHaveAttribute("aria-checked", "true", { timeout: 10_000 });
    });
    await shoot(junto.page, "7-relaunch-kept");
  } finally {
    console.log("Q4", JSON.stringify(results));
    await junto.close();
  }
  for (const r of results) expect.soft(r.pass, `${r.row}: ${r.detail ?? ""}`).toBe(true);
});
