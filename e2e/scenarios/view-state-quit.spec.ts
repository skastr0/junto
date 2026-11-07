/**
 * What the operator left open comes back after Junto quits fully.
 *
 * In an Artifacts node the operator makes two documents, names them, and
 * opens the first again. Junto quits; a new app starts on the same home.
 * Opening the node shows that document, not the newest one.
 *   scripts/run-e2e.sh e2e/scenarios/view-state-quit.spec.ts
 */
import type { Page } from "@playwright/test";
import { Schema } from "effect";
import { Node } from "../../src/shared/model";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";

const shelf = Schema.decodeUnknownSync(Node)({ kind: "artifacts", id: "shelf", label: "Shelf", x: 40, y: 60, width: 280, height: 160, z: 0 });

const openShelf = async (page: Page): Promise<void> => {
  await page.getByRole("group", { name: "Shelf, artifacts" }).dblclick({ timeout: 30_000 });
  await expect(page.getByRole("list", { name: "Artifacts" })).toBeVisible({ timeout: 20_000 });
};

const newDocument = async (page: Page, title: string): Promise<void> => {
  await page.getByRole("button", { name: "New artifact" }).click();
  await page.getByRole("group", { name: "New artifact" }).getByRole("button", { name: "Document" }).click();
  await expect(page.getByRole("textbox", { name: "Title" })).toHaveValue("Untitled document");
  await page.getByRole("textbox", { name: "Title" }).fill(title);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Artifacts" })).toContainText(title);
};

test("the document left open comes back after a full quit", async () => {
  test.setTimeout(180_000);
  const junto = await launchJunto({ seedModels: { "view-state-quit": modelFixture([shelf]) } });
  try {
    await openShelf(junto.page);
    await newDocument(junto.page, "Roadmap");
    await newDocument(junto.page, "Launch plan");
    await junto.page.getByRole("list", { name: "Artifacts" }).getByRole("button", { name: /Roadmap/ }).click();
    await expect(junto.page.getByRole("textbox", { name: "Title" })).toHaveValue("Roadmap");

    const exited = new Promise<void>((resolve) => junto.app.process().once("exit", () => resolve()));
    await junto.app.evaluate(({ app }) => app.quit());
    await exited;

    const again = await launchJunto({ sandbox: junto.sandbox });
    try {
      await openShelf(again.page);
      await expect(again.page.getByRole("textbox", { name: "Title" })).toHaveValue("Roadmap", { timeout: 15_000 });
    } finally {
      await again.close();
    }
  } finally {
    await junto.close().catch(() => undefined);
  }
});
