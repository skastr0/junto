/**
 * Selecting a wire opens the RTS relation surface, which reads it
 * back. There is no edge settings form any more: an edge carries exactly one
 * authored word, so the pair strip speaks the verb and offers the pair's
 * other verb where there is one.
 *
 * Geography cannot carry the fixture — a wire between two plain text nodes
 * holds no verb and is dropped at decode — so the pair is agent → agent,
 * wired by `messages`.
 */
import { agentTextNode, canvasDoc, verbEdge } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const nodes = [
  agentTextNode({
    id: "source",
    key: "local:edge-settings",
    label: "Source node",
    x: 0,
    y: 0,
  }),
  agentTextNode({
    id: "target",
    key: "local:edge-settings-target",
    label: "Target node",
    x: 420,
    y: 0,
  }),
];

const edge = verbEdge("e-settings", "source", "target", "messages", nodes);

test.use({
  juntoOptions: {
    seedCanvases: {
      "edge-settings": canvasDoc(nodes, [edge]),
    },
  },
});

test("selecting a wire between two seats opens its relation surface", async ({ junto }) => {
  const { page } = junto;
  const flowEdge = page.getByTestId("rf__edge-e-settings");
  const source = page.getByTestId("rf__node-source");
  const target = page.getByTestId("rf__node-target");

  await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
  await expect(flowEdge).toHaveCount(1, { timeout: 30_000 });
  await expect(source).toBeVisible({ timeout: 30_000 });
  await expect(target).toBeVisible({ timeout: 30_000 });

  // Between two seats the wire's midpoint is a covered hit target; its
  // keyboard affordance ("Select edge") opens the same relation surface.
  await page.getByRole("button", { name: /^Select edge -/ }).first().press("Enter");

  // Middle third: the verb, then the sentence it makes of the two ends.
  const kindSurface = page.locator(".rts-kind-surface");
  await expect(kindSurface).toBeVisible({ timeout: 10_000 });
  await expect(kindSurface.locator(".rts-kind-kind-label")).toHaveText("messages");
  const relation = kindSurface.locator('[role="toolbar"][aria-label="Relation"]');
  await expect(relation).toBeVisible();
  await expect(relation).toContainText("Source node messages Target node");

  // Left third: the pair and the delete action.
  await expect(page.locator(".rts-cmd__title")).toContainText("Source node → Target node");
  await expect(page.getByRole("button", { name: "Delete relation" })).toBeVisible();
});
