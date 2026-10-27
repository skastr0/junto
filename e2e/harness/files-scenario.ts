/**
 * Setup for the 0.11 Files real-app specs this seat owns: quick open (F4),
 * drops (F5), comments (F7) and the design audit. Each test stages its own
 * copy of the fixture folder under a temp parent, so no spec reads or writes
 * another's files, and seeds a Files node rooted on that copy.
 *
 * The names the specs find, as the surfaces expose them today:
 *   Files modal    role dialog named "Files"
 *   tree           role tree; rows are role treeitem with data-item-path
 *   file editor    a textarea named by its path (the F3 stand-in)
 *   quick open     data-testid quick-open; input quick-open-input; rows .quick-open__row
 *   drop target    data-drop "root" or "folder" on the modal while a drag hovers
 *   box comments   data-testid file-box-layer, file-box-draft, file-box-thread
 *   comments rail  the artifact rail: New comment (Meta+Enter posts), Threads
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, type JSHandle, type Locator, type Page } from "@playwright/test";
import type { Node } from "../../src/shared/model";
import { THIS_MACHINE } from "../../tests/support/machines";
import { buildFilesFixture, type FilesFixture } from "./files-fixture";
import { modelNode } from "./model";

export const FILES_ID = "files";

export interface FilesStage {
  readonly parent: string;
  readonly fixture: FilesFixture;
  /** Writes `relPath` under the stage's incoming folder, beside the root, and returns its absolute path. */
  readonly incoming: (relPath: string, text: string) => Promise<string>;
  readonly cleanup: () => Promise<void>;
}

/** A fresh fixture under a temp parent, named in its real form: macOS keeps /var as a link to /private/var. */
export const stageFiles = async (): Promise<FilesStage> => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "junto-files-")));
  const fixture = await buildFilesFixture(parent);
  return {
    parent,
    fixture,
    incoming: async (relPath, text) => {
      const path = join(parent, "incoming", relPath);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
      return path;
    },
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
};

/** A Files node on THIS_MACHINE, rooted at `root`. */
export const filesNode = (root: string): Node =>
  modelNode({ kind: "files", id: FILES_ID, label: "Files", x: 60, y: 60, width: 280, height: 160, z: 0, host: THIS_MACHINE, root });

export const filesCard = (page: Page): Locator => page.locator(`.react-flow__node[data-id="${FILES_ID}"]`);

/** Double-clicks the Files card, as the operator opens it, and returns the modal. */
export const openFilesModal = async (page: Page): Promise<Locator> => {
  await expect(filesCard(page)).toBeVisible({ timeout: 30_000 });
  await filesCard(page).dblclick();
  const modal = page.getByRole("dialog", { name: "Files" });
  await expect(modal).toBeVisible({ timeout: 20_000 });
  return modal;
};

/** The tree row for a path relative to the root; a folder's path may carry a trailing slash. */
export const treeRow = (modal: Locator, path: string): Locator =>
  modal.locator(`[role="treeitem"][data-item-path="${path}"], [role="treeitem"][data-item-path="${path}/"]`);

/** Expands a folder row if it is shut; an open folder stays open. */
export const expandInTree = async (modal: Locator, path: string): Promise<void> => {
  const folder = treeRow(modal, path);
  await expect(folder).toBeVisible({ timeout: 15_000 });
  if ((await folder.getAttribute("aria-expanded")) !== "true") await folder.click();
};

/**
 * Clicks down a path in the tree: each folder expands, and the file row opens the file in the main pane.
 * A chain of folders with one child folder each is one row (@pierre/trees flattens it), so a path through
 * such a chain has no row per folder; the specs open files only outside those chains.
 */
export const openInTree = async (modal: Locator, path: string): Promise<void> => {
  const parts = path.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) await expandInTree(modal, parts.slice(0, depth).join("/"));
  const file = treeRow(modal, path);
  await expect(file).toBeVisible({ timeout: 15_000 });
  await file.click();
};

const STAGE_ID = "e2e-files-stage";

/**
 * The files as a Finder drag hands them over: File objects that carry their real
 * paths, in a DataTransfer. Playwright cannot start a native drag, so the files go
 * through a hidden file input, which Chromium gives the same real paths.
 */
export const transferOf = async (page: Page, files: readonly string[]): Promise<JSHandle<DataTransfer>> => {
  await page.evaluate((id) => {
    if (document.getElementById(id) !== null) return;
    const input = document.createElement("input");
    input.id = id;
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    document.body.append(input);
  }, STAGE_ID);
  await page.locator(`#${STAGE_ID}`).setInputFiles(files);
  return page.evaluateHandle((id) => {
    const transfer = new DataTransfer();
    const input = document.getElementById(id) as HTMLInputElement;
    for (const file of Array.from(input.files ?? [])) transfer.items.add(file);
    return transfer;
  }, STAGE_ID);
};

/** A drag arrives over `target`: dragenter, then dragover. No drop. */
export const hover = async (target: Locator, transfer: JSHandle<DataTransfer>): Promise<void> => {
  await target.dispatchEvent("dragenter", { dataTransfer: transfer });
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
};

/** The drag leaves `target` without dropping. */
export const leave = (target: Locator, transfer: JSHandle<DataTransfer>): Promise<void> =>
  target.dispatchEvent("dragleave", { dataTransfer: transfer });

/** The files land on `target`, with no hover before the drop. */
export const dropOn = (target: Locator, transfer: JSHandle<DataTransfer>): Promise<void> =>
  target.dispatchEvent("drop", { dataTransfer: transfer });

/** A whole Finder drop: the hover, then the drop. */
export const drop = async (target: Locator, transfer: JSHandle<DataTransfer>): Promise<void> => {
  await hover(target, transfer);
  await dropOn(target, transfer);
};

/**
 * A drag from one tree row onto another, with the mouse in steps, so the tree sees a drag rather than a click.
 * Playwright's dragTo makes a single move, which can stay under the tree's drag threshold.
 */
export const dragRow = async (page: Page, from: Locator, to: Locator): Promise<void> => {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (start === null || end === null) throw new Error("a tree row has no size to drag from or to");
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 12 });
  await page.mouse.up();
};
