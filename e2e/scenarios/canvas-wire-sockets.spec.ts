/**
 * A wire leaves and enters by the sockets that face each other, read off where
 * the two cards sit, whatever sides the edge happens to store.
 */
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const nodes = [
  agentTextNode({ id: "hub", key: "local:wire-sockets", label: "Hub", x: 0, y: 0 }),
  agentTextNode({ id: "below", key: "local:wire-sockets-below", label: "Below", x: 0, y: 260 }),
  agentTextNode({ id: "left", key: "local:wire-sockets-left", label: "Left", x: -520, y: 0 }),
  agentTextNode({ id: "diagonal", key: "local:wire-sockets-diagonal", label: "Diagonal", x: 620, y: -420 }),
];

const edges = [
  verbEdge("e-below", "hub", "below", "messages", nodes),
  verbEdge("e-left", "hub", "left", "messages", nodes),
  verbEdge("e-diagonal", "hub", "diagonal", "messages", nodes),
];

test.use({
  juntoOptions: {
    seedCanvases: {
      "wire-sockets": canvasDoc(nodes, edges),
    },
  },
});

test("each wire uses the sockets that face its far end", async ({ junto }) => {
  const { page } = junto;
  await expect(page.locator("path.junto-edge")).toHaveCount(3, { timeout: 30_000 });
  await expect(page.getByTestId("rf__node-diagonal")).toBeVisible({ timeout: 30_000 });

  // A socket sits just outside its card's edge.
  const NEAR = 16;
  const read = async (edgeId: string, from: string, to: string) => {
    const ends = await page.locator(`[data-testid="rf__edge-${edgeId}"] path.junto-edge`).evaluate((element) => {
      const path = element as SVGPathElement;
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error("wire has no screen matrix");
      const at = (length: number) => {
        const point = path.getPointAtLength(length);
        const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
        return { x: screen.x, y: screen.y };
      };
      return { start: at(0), end: at(path.getTotalLength()) };
    });
    const a = await page.getByTestId(`rf__node-${from}`).boundingBox();
    const b = await page.getByTestId(`rf__node-${to}`).boundingBox();
    if (!a || !b) throw new Error("node has no box");
    return { ...ends, a, b };
  };
  const near = (value: number, edge: number): boolean => Math.abs(value - edge) < NEAR;

  // Stacked: out of the hub's bottom, into the top.
  await expect.poll(async () => {
    const { start, end, a, b } = await read("e-below", "hub", "below");
    return near(start.y, a.y + a.height) && near(end.y, b.y);
  }).toBe(true);

  // To the left on the same row: out of the hub's left, into the right.
  await expect.poll(async () => {
    const { start, end, a, b } = await read("e-left", "hub", "left");
    return near(start.x, a.x) && near(end.x, b.x + b.width);
  }).toBe(true);

  // Up and to the right: one corner, out of the hub's right, into the bottom.
  await expect.poll(async () => {
    const { start, end, a, b } = await read("e-diagonal", "hub", "diagonal");
    return near(start.x, a.x + a.width) && near(end.y, b.y + b.height);
  }).toBe(true);
});
