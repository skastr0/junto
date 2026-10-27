/**
 * 0.11 F4, quick open (Cmd+P) inside a node's modal: file names under a Files
 * node's root, and the items of Artifacts, Tasks and Automations. Real app,
 * seeded canvases, and the fixture folder from e2e/harness/files-fixture.ts.
 *   bun run test:e2e:fast e2e/scenarios/files-quick-open.spec.ts
 * Fixme until F4 is on main: the palette and its rows are in the working tree
 * only. Drop the describe.fixme when they land.
 */
import type { Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelNode, modelSeat } from "../harness/model";
import { filesCard, filesNode, openFilesModal, stageFiles } from "../harness/files-scenario";

const CANVAS = "files-quick-open";

const palette = (page: Page) => page.getByTestId("quick-open");

/** The palette is enabled once the root has listed: a chord pressed before that is dropped, so wait for the first row. */
const openReadyFilesModal = async (page: Page) => {
  const modal = await openFilesModal(page);
  await expect(modal.getByRole("treeitem", { name: "README.md", exact: true })).toBeVisible({ timeout: 15_000 });
  return modal;
};
const field = (page: Page) => page.getByTestId("quick-open-input");
const titles = (page: Page) => palette(page).locator(".quick-open__row-title");
const details = (page: Page) => palette(page).locator(".quick-open__row-detail");
const active = (page: Page) => palette(page).locator('[data-active="true"]');

test.describe.fixme("quick open in every node that has items (F4)", () => {
  test("Cmd+P filters file names, Enter opens the pick, and Escape closes only the palette", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
    try {
      const { page } = junto;
      const modal = await openReadyFilesModal(page);

      await page.keyboard.press("Meta+p");
      await expect(palette(page)).toBeVisible();
      await expect(field(page)).toBeFocused();
      await field(page).fill("readme");
      await expect(titles(page).first()).toHaveText("README.md"); // link-readme.md also matches the query

      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
      await expect(modal.getByRole("textbox", { name: "README.md", exact: true })).toHaveValue(/A root for the Files node/);

      await page.keyboard.press("Meta+p");
      await expect(palette(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(palette(page)).toHaveCount(0);
      await expect(modal).toBeVisible();
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("names rank by closeness, and each row shows its folder down to nested paths", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
    try {
      const { page } = junto;
      await openReadyFilesModal(page);
      await page.keyboard.press("Meta+p");
      for (const [query, title, folder] of [
        ["bigts", "big.ts", "src"],
        ["meeting", "meeting notes.txt", "notes"],
        ["deep", "deep.txt", "nested/a/b/c"],
      ] as const) {
        await field(page).fill(query);
        await expect(titles(page).first()).toHaveText(title);
        await expect(details(page).first()).toHaveText(folder);
      }
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("node_modules and files outside the root are not offered, and an empty result says so", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
    try {
      const { page } = junto;
      await openReadyFilesModal(page);
      await page.keyboard.press("Meta+p");

      await field(page).fill("index");
      await expect(palette(page).getByText("No file matches.")).toBeVisible();

      // The file beside the root is `secret.txt`; the symlink inside the root is named differently.
      await field(page).fill("secret");
      await expect(titles(page).filter({ hasText: /^secret\.txt$/ })).toHaveCount(0);
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("the arrow keys move the highlight, and Enter opens the highlighted row", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
    try {
      const { page } = junto;
      await openReadyFilesModal(page);
      await page.keyboard.press("Meta+p");
      await field(page).fill("txt");
      await expect(active(page)).toHaveCount(1);
      const [first, second] = [await titles(page).nth(0).innerText(), await titles(page).nth(1).innerText()];
      await expect(active(page).locator(".quick-open__row-title")).toHaveText(first);

      await page.keyboard.press("ArrowDown");
      await expect(active(page).locator(".quick-open__row-title")).toHaveText(second);

      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("the header button opens the same palette, and Cmd+P on the bare canvas does nothing", async () => {
    test.setTimeout(120_000);
    const stage = await stageFiles();
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });
    try {
      const { page } = junto;
      await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Meta+p");
      await expect(palette(page)).toHaveCount(0);

      const modal = await openReadyFilesModal(page);
      // The header button's name is the palette's find label for files; confirm it when the button lands.
      await modal.getByRole("button", { name: "Find a file", exact: true }).click();
      await expect(palette(page)).toBeVisible();
      await expect(field(page)).toHaveAttribute("aria-label", "Find a file");
    } finally {
      await junto.close();
      await stage.cleanup();
    }
  });

  test("Artifacts: Cmd+P finds an artifact by its title and opens it", async () => {
    test.setTimeout(120_000);
    const shelf = modelNode({ kind: "artifacts", id: "shelf", label: "Shelf", x: 400, y: 60, width: 280, height: 160, z: 0 });
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([shelf]) } });
    try {
      const { page } = junto;
      await page.locator('.react-flow__node[data-id="shelf"]').dblclick();
      await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
      for (const noun of ["Document", "Sheet"]) {
        await page.getByRole("button", { name: "New artifact" }).click();
        await page.getByRole("group", { name: "New artifact" }).locator("button").filter({ hasText: noun }).click();
      }

      await page.keyboard.press("Meta+p");
      await field(page).fill("sheet");
      await expect(titles(page)).toHaveText(["Untitled sheet"]);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
      await expect(page.locator(".artifact-head__title")).toHaveValue("Untitled sheet");
    } finally {
      await junto.close();
    }
  });

  test("Tasks: Cmd+P finds a task on the board by its title and opens it", async () => {
    test.setTimeout(120_000);
    const board = modelNode({ kind: "task", id: "board", name: "Board", x: 400, y: 60, width: 320, height: 220, z: 0 });
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([board]) } });
    try {
      const { page } = junto;
      await page.locator('.react-flow__node[data-id="board"]').dblclick();
      for (const title of ["Review the draft", "Ship it"]) {
        await page.getByRole("button", { name: "New task", exact: true }).first().click();
        await page.getByLabel("Task title").fill(title);
        await page.keyboard.press("Enter");
        await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
      }

      await page.keyboard.press("Meta+p");
      await field(page).fill("review");
      await expect(titles(page)).toHaveText(["Review the draft"]);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
    } finally {
      await junto.close();
    }
  });

  test("Automations: Cmd+P finds an automation by name and opens it in the editor", async () => {
    test.setTimeout(120_000);
    const lead = modelSeat({ id: "lead", key: "local:quick-open-lead", label: "lead", x: 40, y: 40 });
    const autos = modelNode({ kind: "automations", id: "auto", label: "Automations", x: 360, y: 40, width: 260, height: 120, z: 0 });
    const junto = await launchJunto({ seedModels: { [CANVAS]: modelFixture([lead, autos]) } });
    try {
      const { page } = junto;
      await page.locator('.react-flow__node[data-id="auto"]').dblclick();
      const pane = page.getByTestId("automations-node");
      await pane.getByRole("button", { name: "New automation" }).first().click();
      const editor = pane.getByTestId("automation-editor");
      await editor.getByLabel("Automation name").fill("Morning standup");
      const mailTo = editor.getByLabel("Mail to");
      await mailTo.click();
      await mailTo.pressSequentially("@lead");
      await page.getByRole("option", { name: /lead/ }).first().click();
      await editor.getByLabel("Mail text").fill("Post your plan for today.");
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(pane.getByRole("button", { name: /Morning standup/ })).toBeVisible({ timeout: 10_000 });

      await page.keyboard.press("Meta+p");
      await field(page).fill("standup");
      await expect(titles(page)).toHaveText(["Morning standup"]);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toHaveCount(0);
      await expect(editor.getByLabel("Automation name")).toHaveValue("Morning standup");
    } finally {
      await junto.close();
    }
  });
});
