/**
 * 0.11 F2 in the real app: saving and the root's edge.
 *
 * Cmd+S writes the open file and clears Unsaved. A save over a file that
 * changed on disk is refused stale and offers Reload from disk (the draft goes,
 * the disk wins) or Keep mine (the draft is written over it).
 *   bun run test:e2e:fast e2e/scenarios/files-save-scope.spec.ts
 */
import { readFileSync } from "node:fs";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture } from "../harness/model";
import { filesNode, openFilesModal, openInTree, stageFiles, type FilesStage } from "../harness/files-scenario";
import { mod, TEXT_END } from "../harness/keys";

const CANVAS = "files-save-scope";
const FILE = "notes/meeting notes.txt";
const ON_DISK = "spaced name\n";

const launch = (stage: FilesStage) => launchJunto({ seedModels: { [CANVAS]: modelFixture([filesNode(stage.fixture.root)]) } });

/** Opens the file and types `text` at its end. */
const typeAtEnd = async (page: Page, modal: Locator, text: string): Promise<void> => {
  const editor = modal.locator(".cm-content");
  await expect(editor).toContainText("spaced name", { timeout: 15_000 });
  await editor.click();
  await page.keyboard.press(TEXT_END);
  await page.keyboard.type(text);
  await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toBeVisible();
};

/** Another program writes the file, with an mtime the app cannot have seen. */
const changeOnDisk = async (path: string, text: string): Promise<void> => {
  await writeFile(path, text);
  const later = new Date(Date.now() + 5_000);
  await utimes(path, later, later);
};

test("Cmd+S writes the open file and clears Unsaved", async () => {
  test.setTimeout(120_000);
  const stage = await stageFiles();
  const junto = await launch(stage);
  try {
    const { page } = junto;
    const modal = await openFilesModal(page);
    await openInTree(modal, FILE);
    await typeAtEnd(page, modal, "saved by Cmd+S");

    await page.keyboard.press(mod("s"));

    await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toHaveCount(0, { timeout: 15_000 });
    expect(readFileSync(join(stage.fixture.root, FILE), "utf8")).toBe(`${ON_DISK}saved by Cmd+S`);
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});

test("a save over a changed file is refused stale; Keep mine writes the draft, Reload from disk drops it", async () => {
  test.setTimeout(120_000);
  const stage = await stageFiles();
  const junto = await launch(stage);
  const disk = join(stage.fixture.root, FILE);
  try {
    const { page } = junto;
    const modal = await openFilesModal(page);
    await openInTree(modal, FILE);
    const stale = modal.getByRole("alert").filter({ has: page.getByRole("button", { name: "Keep mine" }) });

    // Keep mine.
    await typeAtEnd(page, modal, "mine");
    await changeOnDisk(disk, "theirs\n");
    await page.keyboard.press(mod("s"));
    await expect(stale).toBeVisible({ timeout: 15_000 });
    expect(readFileSync(disk, "utf8")).toBe("theirs\n");
    await stale.getByRole("button", { name: "Keep mine" }).click();
    await expect(stale).toHaveCount(0, { timeout: 15_000 });
    await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toHaveCount(0);
    expect(readFileSync(disk, "utf8")).toBe(`${ON_DISK}mine`);

    // Reload from disk.
    await page.keyboard.press(TEXT_END);
    await modal.locator(".cm-content").click();
    await page.keyboard.press(TEXT_END);
    await page.keyboard.type(" dropped");
    await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toBeVisible();
    await changeOnDisk(disk, "theirs again\n");
    await page.keyboard.press(mod("s"));
    await expect(stale).toBeVisible({ timeout: 15_000 });
    await stale.getByRole("button", { name: "Reload from disk" }).click();
    await expect(stale).toHaveCount(0, { timeout: 15_000 });
    await expect(modal.locator(".cm-content")).toHaveText("theirs again", { timeout: 15_000 });
    await expect(modal.getByRole("status").filter({ hasText: "Unsaved" })).toHaveCount(0);
    expect(readFileSync(disk, "utf8")).toBe("theirs again\n");
  } finally {
    await junto.close();
    await stage.cleanup();
  }
});
