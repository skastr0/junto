import { commandModel, readModelNode } from "../harness/model";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { CanvasDoc } from "../../src/shared/canvas";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "note-focus-surface";
const SHOTS = join(process.cwd(), "test-results", "note-focus-surface");

const document: CanvasDoc = {
  nodes: [
    {
      id: "note-1",
      type: "text",
      text: "# Field notes\n\nThe operator draft stays put.",
      x: 0,
      y: 0,
      width: 320,
      height: 220,
    },
  ],
  edges: [],
};

test("Note focus survives canvas updates", async () => {
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: document },
  });
  try {
    const { page } = junto;
    await mkdir(SHOTS, { recursive: true });
    await expect(page.locator('.react-flow__node[data-id="note-1"]')).toBeVisible({
      timeout: 30_000,
    });

    await page.locator('.react-flow__node[data-id="note-1"]').click();
    await page.getByRole("button", { name: "Expand note editor" }).click();
    const noteEditor = page.getByRole("dialog", { name: "Edit note" });
    const textarea = noteEditor.getByLabel("Note markdown");
    await expect(noteEditor).toBeVisible();
    await textarea.fill("# Field notes\n\nUnsaved operator draft");

    const note = await readModelNode(page, CANVAS, "note-1");
    expect(note).toBeDefined();
    await commandModel(page, { _tag: "Move", canvas: CANVAS, moves: [{ id: note!.id, x: note!.x + 8, y: note!.y }] });

    await expect(noteEditor).toBeVisible();
    await expect(textarea).toHaveValue("# Field notes\n\nUnsaved operator draft");
    await page.screenshot({
      path: join(SHOTS, "note-focus-after-canvas-update.png"),
      fullPage: false,
    });

    await noteEditor.getByRole("button", { name: "done", exact: true }).click();
    await expect(noteEditor).toBeHidden();
  } finally {
    await junto.close();
  }
});
