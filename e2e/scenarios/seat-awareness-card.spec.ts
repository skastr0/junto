/**
 * Seat awareness on a real card — the advisory surface paints.
 *
 *   bun run test:e2e e2e/scenarios/seat-awareness-card.spec.ts
 *
 * The hover is a leaf component with its own tests, and a preview renders it
 * from literals. Neither can catch the failure this spec exists for: mounted
 * inside the card body, the hover is in the DOM with a real box and is painted
 * away by the node shell's `overflow: hidden`, so the entire advisory surface
 * reaches the renderer and is displayed by nothing.
 *
 * So the assertion is not `toBeVisible()` — that passes for a clipped element.
 * It is a hit test at the hover's own box: the element under that point must be
 * the hover or one of its descendants.
 */
import { agentTextNode, canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

test.use({
  juntoOptions: {
    seedCanvases: {
      awareness: canvasDoc([
        agentTextNode({
          id: "e2e-awareness-agent",
          key: "e2e-awareness-agent-binding",
          label: "Awareness agent",
          x: 80,
          y: 40,
        }),
        terminalTextNode({
          id: "e2e-awareness-term",
          bindingId: "e2e-awareness-term-binding",
          label: "Awareness terminal",
          x: 460,
          y: 40,
        }),
      ]),
    },
  },
});

/** The element under the hover's own box must be the hover. */
const paintsAt = (locator: import("@playwright/test").Locator) =>
  locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + Math.min(24, rect.width / 2),
      rect.top + Math.min(16, rect.height / 2),
    );
    return {
      inside: hit !== null && el.contains(hit),
      hit: hit === null ? "none" : hit.className.toString().slice(0, 60) || hit.tagName,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });

test("the advisory hover paints on a seat card, both node kinds", async ({ junto }) => {
  test.setTimeout(180_000);
  const { page } = junto;

  const agent = page.locator(".react-flow__node", { hasText: "Awareness agent" });
  await expect(agent).toBeVisible({ timeout: 60_000 });
  await agent.hover();
  const agentHover = agent.locator("[data-seat-awareness]");
  await expect(agentHover).toBeVisible({ timeout: 20_000 });
  // The advisory plane is on by default now; with no key in this sandbox the
  // honest answer is a named unavailability, never a fabricated judgment.
  await expect(agentHover).toContainText(/AI assessment unavailable|recent terminal output available/);
  const agentProbe = await paintsAt(agentHover);
  console.log("AWARENESS CARD PROBE agent " + JSON.stringify(agentProbe));
  expect(agentProbe.width).toBeGreaterThan(200);
  expect(agentProbe.inside).toBe(true);
  await page.screenshot({
    path: ".amp/in/artifacts/seat-awareness-card-agent.png",
  });

  const term = page.locator(".react-flow__node", { hasText: "Awareness terminal" });
  await term.hover();
  const termHover = term.locator("[data-seat-awareness]");
  await expect(termHover).toBeVisible({ timeout: 20_000 });
  const termProbe = await paintsAt(termHover);
  console.log("AWARENESS CARD PROBE terminal " + JSON.stringify(termProbe));
  expect(termProbe.inside).toBe(true);
  await page.screenshot({
    path: ".amp/in/artifacts/seat-awareness-card-terminal.png",
  });
});
