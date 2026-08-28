/**
 * Double-clicking a wire selects it and the RTS relation surface reads it
 * back. There is no edge settings form any more: an edge carries exactly one
 * authored word, so the pair strip speaks the verb and offers the pair's
 * other verb where there is one.
 *
 * Geography cannot carry the fixture — a wire between two plain text nodes
 * holds no verb and is dropped at decode — so the pair is agent → task,
 * which admits both `contributes` and `manages`.
 */
import { agentTextNode, canvasDoc, tasksNode, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const nodes = [
  agentTextNode({
    id: "source",
    key: "local:edge-settings",
    label: "Source node",
    x: 0,
    y: 0,
  }),
  { ...tasksNode({ id: "target", x: 420, y: 0 }), text: "Target node" },
];

const edge = verbEdge("e-settings", "source", "target", "contributes", nodes);

test.use({
  vellumOptions: {
    seedCanvases: {
      "edge-settings": canvasDoc(nodes, [edge]),
    },
  },
});

test("double-clicking an edge opens its relation surface", async ({ vellumCommand }) => {
  const { page } = vellumCommand;
  const flowEdge = page.getByTestId("rf__edge-e-settings");
  const source = page.getByTestId("rf__node-source");
  const target = page.getByTestId("rf__node-target");

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(flowEdge).toHaveCount(1, { timeout: 30_000 });
  await expect(source).toBeVisible({ timeout: 30_000 });
  await expect(target).toBeVisible({ timeout: 30_000 });

  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  expect(sourceBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  if (!sourceBox || !targetBox) return;
  await page.mouse.dblclick(
    (sourceBox.x + sourceBox.width + targetBox.x) / 2,
    (sourceBox.y + sourceBox.height / 2 + targetBox.y + targetBox.height / 2) / 2,
  );

  // Middle third: the verb, then the sentence it makes of the two ends.
  const kindSurface = page.locator(".rts-kind-surface");
  await expect(kindSurface).toBeVisible({ timeout: 10_000 });
  await expect(kindSurface.locator(".rts-kind-kind-label")).toHaveText("contributes");
  const relation = kindSurface.locator('[role="toolbar"][aria-label="Relation"]');
  await expect(relation).toBeVisible();
  await expect(relation).toContainText("Source node contributes to Target node");
  // agent → task holds two verbs, so the strip offers the swap to the other.
  await expect(relation.getByRole("button", { name: "Change to manages" })).toBeVisible();

  // Left third: the pair and the delete action.
  await expect(page.locator(".rts-cmd__title")).toContainText("Source node → Target node");
  await expect(page.getByRole("button", { name: "Delete relation" })).toBeVisible();
});
