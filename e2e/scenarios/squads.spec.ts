/**
 * Squads in the real app: save selected agent seats as a squad from the
 * multi-select menu, find it in the add picker, place it inside a region,
 * and manage it. A save always makes a new squad: no replace, no opening
 * prompts. Screenshots land in $JUNTO_SHOTS_DIR or test-results/squads/
 * (never committed). Both themes.
 *
 * Capture and placement rules are unit-tested in tests/squads.test.ts.
 * Run: `bunx electron-vite build && bun run test:e2e:fast e2e/scenarios/squads.spec.ts`
 */
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const shotsDir = process.env.JUNTO_SHOTS_DIR ?? "test-results/squads";

const fixtureDoc = canvasDoc(
  [
    agentTextNode({ id: "seat-a", key: "local:alpha", label: "alpha", x: 0, y: 0 }),
    agentTextNode({ id: "seat-b", key: "local:beta", label: "beta", x: 420, y: 0 }),
    agentTextNode({ id: "seat-c", key: "local:gamma", label: "gamma", x: 210, y: 320 }),
    {
      id: "rg-lab",
      type: "group",
      label: "lab",
      x: 1000,
      y: -40,
      width: 900,
      height: 560,
      ether: { region: { defaults: { paths: { local: "/tmp" } } } },
    },
  ],
  [{ id: "e-ab", fromNode: "seat-a", toNode: "seat-b", ether: { verb: "messages" } }],
);

/** A node's box once it has stopped moving (the camera settles after load). */
const stableBox = async (locator: import("@playwright/test").Locator) => {
  let previous: { x: number; y: number; width: number; height: number } | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const box = await locator.boundingBox();
    if (box && previous && Math.abs(box.x - previous.x) < 0.5 && Math.abs(box.y - previous.y) < 0.5) return box;
    previous = box;
    await locator.page().waitForTimeout(250);
  }
  if (!previous) throw new Error("node never laid out");
  return previous;
};

const installBoard = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(() => Boolean((globalThis as { junto?: { listCanvases?: unknown } }).junto?.listCanvases)),
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.evaluate(async (document) => {
    const api = window.junto!;
    let name = (await api.listCanvases())[0]?.name;
    if (!name) name = (await api.createCanvas("squads")).name;
    const read = await api.readCanvas(name);
    await api.writeCanvas(name, document, read.revision);
  }, fixtureDoc);
};

const setTheme = async (page: import("@playwright/test").Page, theme: "Dark" | "Bright") => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Appearance" }).click();
  await page.getByRole("radio", { name: theme }).click();
  await page.locator(".settings-panel__close").click();
  await page.waitForTimeout(300);
};

for (const theme of ["Dark", "Bright"] as const) test(`squads (${theme}): save from the menu, place from the picker, manage`, async ({ junto }) => {
  const { page } = junto;
  const shots = `${shotsDir}/${theme.toLowerCase()}`;
  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await setTheme(page, theme);
  await installBoard(page);

  const seat = (id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
  for (const id of ["seat-a", "seat-b", "seat-c"]) await expect(seat(id)).toBeVisible({ timeout: 30_000 });

  // Frame the whole board so the region is on screen too.
  await page.getByRole("button", { name: "Fit all nodes" }).click();
  await stableBox(page.locator('.react-flow__node[data-id="rg-lab"]'));

  // Select the three seats and open the multi-select menu on them.
  await page.keyboard.down("Shift");
  for (const id of ["seat-a", "seat-b", "seat-c"]) {
    const box = await stableBox(seat(id));
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await page.keyboard.up("Shift");
  for (const id of ["seat-a", "seat-b", "seat-c"]) await expect(seat(id)).toHaveClass(/selected/);
  const cBox = await stableBox(seat("seat-c"));
  await page.mouse.click(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2, { button: "right" });
  const saveEntry = page.getByRole("button", { name: "Save 3 agents as a squad" });
  await expect(saveEntry).toBeVisible();
  await page.screenshot({ path: `${shots}/1-menu-entry.png` });
  await saveEntry.click();

  // Name it and save: a name, nothing else to fill in.
  const dialog = page.getByRole("dialog", { name: "Save as squad" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("3 agents, 1 connection");
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog).not.toContainText(/opening prompt|prompt each seat|replace/i);
  await dialog.getByRole("textbox", { name: "Squad name" }).fill("Review squad");
  await page.screenshot({ path: `${shots}/2-save-dialog.png` });
  await dialog.getByRole("button", { name: "Save squad" }).click();
  await expect(dialog).toHaveCount(0);

  const stored = await page.evaluate(() => window.junto!.squadsList());
  expect(stored.map((squad) => [squad.name, squad.seats.length, squad.edges.length])).toEqual([
    ["Review squad", 3, 1],
  ]);
  expect(stored[0]).not.toHaveProperty("prompt");

  // Saving again under a taken name never replaces it: the name is refused.
  await page.mouse.click(cBox.x + cBox.width / 2, cBox.y + cBox.height / 2, { button: "right" });
  await page.getByRole("button", { name: "Save 3 agents as a squad" }).click();
  await dialog.getByRole("textbox", { name: "Squad name" }).fill("review squad");
  await dialog.getByRole("button", { name: "Save squad" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("a squad named review squad already exists");
  await page.screenshot({ path: `${shots}/2b-name-taken.png` });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  const still = await page.evaluate(() => window.junto!.squadsList());
  expect(still.map((squad) => [squad.name, squad.squadId])).toEqual([["Review squad", stored[0]!.squadId]]);

  // Right-click inside the empty region: the add picker shows the squad.
  await page.keyboard.press("Escape");
  const region = page.locator('.react-flow__node[data-id="rg-lab"]');
  const box = await stableBox(region);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const card = page.getByRole("button", { name: "Place squad Review squad, 3 agents, 1 connection" });
  await expect(card).toBeVisible();
  // The squad card is the picker's one card: same slot and width as a node's.
  const squadCard = page.locator('[data-picker-card="squad"]');
  await expect(squadCard).toContainText("alpha, beta, gamma");
  // One read for both cards: the picker is still scaling in, so reads apart differ.
  const [squadSize, catalogSize] = await page.evaluate(() =>
    ["squad", "catalog"].map((kind) => {
      const pickerCard = document.querySelector(`[data-picker-card="${kind}"]`)!;
      const art = pickerCard.querySelector(".picker-card__art")!.getBoundingClientRect();
      return { width: pickerCard.getBoundingClientRect().width, artWidth: art.width, artHeight: art.height };
    }));
  expect(squadSize!.artWidth).toBeCloseTo(catalogSize!.artWidth, 1);
  expect(squadSize!.artHeight).toBeCloseTo(catalogSize!.artHeight, 1);
  expect(squadSize!.width).toBeCloseTo(catalogSize!.width, 0);
  await page.screenshot({ path: `${shots}/3-picker-squads.png` });
  await card.click();

  // Three fresh seats and their connection land inside the region.
  await expect
    .poll(async () => page.evaluate(async () => {
      const api = window.junto!;
      const name = (await api.listCanvases())[0]!.name;
      const { doc } = await api.readCanvas(name);
      const region = doc.nodes.find((node) => node.id === "rg-lab")!;
      const fresh = doc.nodes.filter(
        (node) => node.ether?.entity?.kind === "agent" && !["seat-a", "seat-b", "seat-c"].includes(node.id),
      );
      const inside = fresh.every(
        (node) =>
          node.x >= region.x &&
          node.y >= region.y &&
          node.x + node.width <= region.x + region.width &&
          node.y + node.height <= region.y + region.height,
      );
      const freshIds = new Set(fresh.map((node) => node.id));
      const links = doc.edges.filter((edge) => freshIds.has(edge.fromNode) && freshIds.has(edge.toNode)).length;
      return { seats: fresh.length, inside, links };
    }), { timeout: 15_000 })
    .toEqual({ seats: 3, inside: true, links: 1 });
  // The camera frames the whole placed squad.
  await page.waitForTimeout(800);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const placedBoxes = await page.locator(".react-flow__node.selected").evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; bottom: number }),
  );
  expect(placedBoxes).toHaveLength(3);
  for (const rect of placedBoxes) {
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(viewport.width);
    expect(rect.top).toBeGreaterThanOrEqual(0);
  }
  await page.screenshot({ path: `${shots}/4-placed-in-region.png` });

  // Manage from the picker: rename.
  await page.keyboard.press("Escape");
  await page.mouse.click(box.x + 40, box.y + box.height - 40, { button: "right" });
  await page.getByRole("button", { name: "Manage squad Review squad" }).click();
  const manage = page.getByTestId("squad-manage");
  await expect(manage).toBeVisible();
  // Rename and delete only, and the menu clears the card it manages.
  await expect(manage.getByRole("button")).toHaveText(["Rename", "Delete squad"]);
  const menuBox = (await manage.boundingBox())!;
  const cardBox = (await page.locator('[data-picker-card="squad"]').boundingBox())!;
  expect(menuBox.y >= cardBox.y + cardBox.height || menuBox.y + menuBox.height <= cardBox.y).toBe(true);
  await page.screenshot({ path: `${shots}/5-manage.png` });
  await manage.getByRole("textbox", { name: "Squad name" }).fill("Reviewers");
  await manage.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByRole("button", { name: /Place squad Reviewers/ })).toBeVisible();

  // Delete asks once more, then the squad is gone; placed seats stay.
  await page.getByRole("button", { name: "Manage squad Reviewers" }).click();
  await manage.getByRole("button", { name: "Delete squad" }).click();
  await expect(manage).toContainText("Delete Reviewers for good?");
  await page.screenshot({ path: `${shots}/6-delete-ask.png` });
  await manage.getByRole("button", { name: "Delete Reviewers" }).click();
  await expect(page.locator('[data-picker-card="squad"]')).toHaveCount(0);
  expect(await page.evaluate(() => window.junto!.squadsList())).toEqual([]);
});
