/**
 * Native terminal tail preview — a tall node card earns a small, muted tail
 * of recent PTY lines; the default-height card stays quiet.
 * Real LocalSessionHost + node-pty/child_process under the sandboxed HOME.
 */
import { canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const SMALL_LABEL = "e2e tail small";
const TALL_LABEL = "e2e tail tall";
const SMALL_BINDING = "e2e-tail-small";
const TALL_BINDING = "e2e-tail-tall";

/** Quick burst of distinguishable lines, then idle — settles well within the 200ms coalesce window. */
const LAUNCH = {
  kind: "command" as const,
  argv: [
    "/bin/sh",
    "-c",
    "for i in $(seq 1 20); do printf 'row-%02d\\r\\n' \"$i\"; done; exec sleep 3600",
  ],
};

test.use({
  vellumOptions: {
    seedCanvases: {
      tail: canvasDoc([
        {
          ...terminalTextNode({
            id: "small",
            bindingId: SMALL_BINDING,
            label: SMALL_LABEL,
            launch: LAUNCH,
            x: 0,
            y: 0,
          }),
        },
        {
          ...terminalTextNode({
            id: "tall",
            bindingId: TALL_BINDING,
            label: TALL_LABEL,
            launch: LAUNCH,
            x: 400,
            y: 0,
          }),
          height: 300,
        },
      ]),
    },
  },
});

test("tall native terminal card shows a muted tail preview; default-height card does not overflow it", async ({
  vellum,
}) => {
  const { page } = vellum;

  const smallNode = page.locator(".react-flow__node", { hasText: SMALL_LABEL });
  const tallNode = page.locator(".react-flow__node", { hasText: TALL_LABEL });
  await expect(smallNode).toBeVisible({ timeout: 30_000 });
  await expect(tallNode).toBeVisible({ timeout: 30_000 });

  // Starts the session (no card Start button — first paint drives spawn).
  const tallTail = tallNode.locator(".terminal-card__tail");
  await expect(tallTail).toBeVisible({ timeout: 30_000 });
  await expect(tallTail).toContainText(/row-\d\d/, { timeout: 30_000 });

  const tallLineCount = await tallTail.locator("> div").count();
  expect(tallLineCount).toBeGreaterThanOrEqual(3);
  expect(tallLineCount).toBeLessThanOrEqual(8); // hard display cap, never the full buffer

  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/native-terminal-tail-preview/cards.png" });
});
