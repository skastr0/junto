import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { serializeCanvas } from "../../src/shared/canvas";
import { canvasDoc, readCanvasFile, textNode, writeCanvasFileRaw } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

// App-owned UI edits must land on disk. External raw file edits must NOT mint
// live factory intent (security doctrine Phase 3 first cut).

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

test("external file edit does not hot-reload into live factory intent", async ({
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

  // Wait past the historical watch debounce; live UI must stay on app intent.
  await page.waitForTimeout(700);
  const added = page.locator(".react-flow__node", { hasText: EXTERNAL_NODE_TEXT });
  await expect(added).toHaveCount(0);
  await expect(original).toBeVisible();
});
