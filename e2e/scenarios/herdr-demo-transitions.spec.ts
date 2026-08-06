import { canvasDoc, herdrTextNode } from "../harness/sandbox";
import { demoCommand } from "../harness/demo";
import { expect, test } from "../harness/launch";

// Demo/scripting engine only (VELLUM_COMMAND_DEMO=1) — a scripted herdr mirror
// transport stands in for the real herdr socket (src/main/vellum/demo). The
// canvas node must be bound (ether.herdr) to the same host+paneId the
// scripted transport ensures, exactly like the product's own trailer
// scenario (src/renderer/demo/scenarios/trailer-60.ts).

const HOST = "local";
const PANE_ID = "w1:p01";
const TERMINAL_ID = "term-p01";
const LABEL = "e2e demo pane";

test.use({
  vellumOptions: {
    demo: true,
    seedCanvases: {
      herdr: canvasDoc([
        herdrTextNode({ id: "h1", host: HOST, paneId: PANE_ID, terminalId: TERMINAL_ID, label: LABEL }),
      ]),
    },
  },
});

test("herdr pane reflects working then blocked status transitions", async ({ vellum }) => {
  const { page } = vellum;

  const node = page.locator(".react-flow__node", { hasText: LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });

  await demoCommand(page, {
    kind: "ensure-pane",
    pane: { host: HOST, paneId: PANE_ID, agent: "claude", label: LABEL },
    status: "working",
  });

  await expect(node.getByRole("status", { name: "working" })).toBeVisible({ timeout: 10_000 });

  await demoCommand(page, {
    kind: "set-status",
    host: HOST,
    paneId: PANE_ID,
    status: "blocked",
  });

  await expect(node.getByRole("status", { name: "blocked" })).toBeVisible({ timeout: 10_000 });
});
