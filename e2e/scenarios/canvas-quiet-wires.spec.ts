/**
 * A wire is ground at rest: faint and deaf to the pointer, so a press on it
 * lands on the pane and never selects it. Holding the loupe (Alt) is the
 * canvas's alt mode: the wires show in full and can be picked.
 */
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const nodes = [
  agentTextNode({ id: "source", key: "local:quiet-wires", label: "Source node", x: 0, y: 0 }),
  agentTextNode({ id: "target", key: "local:quiet-wires-target", label: "Target node", x: 520, y: 0 }),
];

const edge = verbEdge("e-quiet", "source", "target", "messages", nodes);

test.use({
  juntoOptions: {
    seedCanvases: {
      "quiet-wires": canvasDoc(nodes, [edge]),
    },
  },
});

test("a wire rests faint and unpickable, and the loupe shows and frees it", async ({ junto }) => {
  const { page } = junto;
  const root = page.locator(".react-flow");
  const wire = page.locator('[data-testid="rf__edge-e-quiet"] path.junto-edge');
  const relation = page.locator('.rts-kind-surface [role="toolbar"][aria-label="Relation"]');

  await expect(root).toBeVisible({ timeout: 30_000 });
  await expect(wire).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("rf__node-target")).toBeVisible({ timeout: 30_000 });

  const midpoint = async (): Promise<{ x: number; y: number }> =>
    wire.evaluate((element) => {
      const path = element as SVGPathElement;
      const at = path.getPointAtLength(path.getTotalLength() / 2);
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error("wire has no screen matrix");
      const point = new DOMPoint(at.x, at.y).matrixTransform(matrix);
      return { x: point.x, y: point.y };
    });
  const opacity = async (): Promise<number> =>
    Number(await wire.evaluate((element) => getComputedStyle(element).opacity));

  // Rest: faint, and a press on the wire reaches the pane.
  await expect.poll(opacity).toBeLessThan(0.2);
  const rest = await midpoint();
  await page.mouse.click(rest.x, rest.y);
  await expect(relation).toHaveCount(0);
  await expect(wire).not.toHaveClass(/junto-edge--selected/);

  // Loupe held: shown in full, and the same press picks the wire.
  await page.mouse.move(rest.x, rest.y + 40);
  await page.keyboard.down("Alt");
  await expect(root).toHaveAttribute("data-wires", "shown");
  await expect.poll(opacity).toBeGreaterThan(0.8);
  const shown = await midpoint();
  await page.mouse.click(shown.x, shown.y);
  await page.keyboard.up("Alt");

  await expect(root).not.toHaveAttribute("data-wires", "shown");
  await expect(relation).toBeVisible({ timeout: 10_000 });
  // A selected wire stays shown after the loupe drops.
  await expect(wire).toHaveClass(/junto-edge--selected/);
  await expect.poll(opacity).toBe(1);
});
