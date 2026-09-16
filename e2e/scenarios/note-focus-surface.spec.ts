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

test("Note focus survives canvas updates and moves to the pinned dock", async () => {
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

    await page.evaluate(async (canvas) => {
      const api = window.vellumCommand;
      if (!api) throw new Error("Junto preload bridge is unavailable");
      const read = await api.readCanvas(canvas);
      const next = {
        ...read.doc,
        nodes: read.doc.nodes.map((node) =>
          node.id === "note-1" ? { ...node, x: node.x + 8 } : node,
        ),
      };
      await api.writeCanvas(canvas, next, read.revision);
    }, CANVAS);

    await expect(noteEditor).toBeVisible();
    await expect(textarea).toHaveValue("# Field notes\n\nUnsaved operator draft");
    await page.screenshot({
      path: join(SHOTS, "note-focus-after-canvas-update.png"),
      fullPage: false,
    });

    await noteEditor.getByRole("button", { name: "Pin note editor" }).click();
    const pinnedNote = page.getByTestId("note-workbench-surface");
    await expect(pinnedNote).toBeVisible();
    await expect(pinnedNote.getByLabel("Note markdown")).toHaveValue(
      "# Field notes\n\nUnsaved operator draft",
    );
    await page.screenshot({
      path: join(SHOTS, "note-pinned.png"),
      fullPage: false,
    });

    await pinnedNote.getByRole("button", { name: "Unpin note editor" }).click();
    await expect(noteEditor).toBeVisible();
    await noteEditor.getByRole("button", { name: "done", exact: true }).click();
    await expect(noteEditor).toBeHidden();
  } finally {
    await junto.close();
  }
});
