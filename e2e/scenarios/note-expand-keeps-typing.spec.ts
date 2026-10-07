/**
 * Typing into a note in place, then Expand, loses nothing.
 *   bun run test:e2e:fast e2e/scenarios/note-expand-keeps-typing.spec.ts
 *
 * Expand takes the press without blurring the in-place field, so the field
 * never commits on its own. The editor must open on what was typed, and the
 * saved note must hold it after done.
 */
import type { CanvasDoc } from "../../src/shared/canvas";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "note-expand";
const document: CanvasDoc = {
  nodes: [{ id: "note-1", type: "text", text: "Field notes", x: 0, y: 0, width: 320, height: 220 }],
  edges: [],
};

test("Expand carries a note's in-place typing into the editor and the saved note", async () => {
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: document } });
  try {
    const { page } = junto;
    const note = page.locator('.react-flow__node[data-id="note-1"]');
    await expect(note).toBeVisible({ timeout: 30_000 });

    await note.click();
    await note.dblclick();
    const inPlace = note.locator('textarea[data-focus-owner="canvas-draft"]');
    await expect(inPlace).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.type(" kept");
    await expect(inPlace).toHaveValue("Field notes kept");

    await page.getByRole("button", { name: "Expand note editor" }).click();
    const editor = page.getByRole("dialog", { name: "Edit note" });
    await expect(editor.getByLabel("Note markdown")).toHaveValue("Field notes kept");
    await editor.getByRole("button", { name: "done", exact: true }).click();
    await expect(editor).toBeHidden();

    await expect
      .poll(async () => {
        const read = await page.evaluate((canvas) => window.junto!.readCanvas(canvas), CANVAS);
        const saved = read.doc.nodes.find((node) => node.id === "note-1");
        return saved?.type === "text" ? saved.text : null;
      })
      .toBe("Field notes kept");
  } finally {
    await junto.close();
  }
});
