import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { serializeCanvas } from "../../src/shared/canvas";
import { canvasDoc, readCanvasFile, textNode, writeCanvasFileRaw } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

// The product's core contract: the .canvas file IS the agent API. Both
// directions must hold — a UI edit lands on disk, and an external file edit
// (an agent rewriting the document) hot-reloads into the UI.

const ORIGINAL_TEXT = "roundtrip original";
const UI_EDITED_TEXT = "roundtrip edited via UI";
const EXTERNAL_NODE_TEXT = "written by an external agent";

test.use({
  vellumOptions: {
    seedCanvases: {
      roundtrip: canvasDoc([textNode("n1", ORIGINAL_TEXT, 0, 0)]),
    },
  },
});

test("UI edit -> file: editing note text in the inspector lands on disk", async ({ vellum }) => {
  const { page, sandbox } = vellum;

  const node = page.locator(".react-flow__node", { hasText: ORIGINAL_TEXT });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();

  const textarea = page.getByLabel("Note text");
  await expect(textarea).toBeVisible();
  await textarea.fill(UI_EDITED_TEXT);
  await textarea.blur();

  await expect(async () => {
    const doc = await readCanvasFile(sandbox, "roundtrip");
    const written = doc.nodes.find((n): n is TextNode => n.id === "n1" && n.type === "text");
    expect(written?.text).toBe(UI_EDITED_TEXT);
  }).toPass({ timeout: 10_000 });
});

test("external file edit -> UI: rewriting the .canvas file hot-reloads a new node", async ({
  vellum,
}) => {
  const { page, sandbox } = vellum;

  const original = page.locator(".react-flow__node", { hasText: ORIGINAL_TEXT });
  await expect(original).toBeVisible({ timeout: 30_000 });

  const externalDoc: CanvasDoc = canvasDoc([
    textNode("n1", ORIGINAL_TEXT, 0, 0),
    textNode("n2", EXTERNAL_NODE_TEXT, 400, 0),
  ]);
  await writeCanvasFileRaw(sandbox, "roundtrip", serializeCanvas(externalDoc));

  const added = page.locator(".react-flow__node", { hasText: EXTERNAL_NODE_TEXT });
  await expect(added).toBeVisible({ timeout: 10_000 });
});
