import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneWorkspaceWorld, touchTrigger, writeScenario } from "../fakes/scenario";
import { canvasDoc, herdrTextNode } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

// Real spawn->parse->mirror pipeline against a fake `herdr` on PATH — no
// demo mode. The fixture world/pane/terminal ids match e2e/fakes/scenario.ts
// oneWorkspaceWorld() exactly, so the terminal binding resolves for real
// (herdr server unix socket, `terminal session control` child) instead of
// going through the scripted demo transport.

const HOST = "local";
const PANE_ID = "w1:p1";
const TERMINAL_ID = "term_1";
const LABEL = "e2e real herdr pane";
const FRAME_TEXT = "hello from fake herdr\n";

test("herdr pane renders the real scripted world, then degrades on a scripted mid-stream close", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-e2e-herdr-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  const closeTrigger = join(scenarioDir, "close-trigger");

  await writeScenario(scenarioPath, {
    world: oneWorkspaceWorld(),
    frames: {
      [TERMINAL_ID]: [
        { text: FRAME_TEXT },
        // Throttled so a replayed reconnect (the fake is stateless — every
        // fresh `terminal session control` child replays this array from the
        // top) cannot spawn processes faster than once per 300ms.
        { waitFor: closeTrigger, delayMs: 300, closed: true, reason: "scripted-mid-stream-close" },
      ],
    },
  });

  const vellum = await launchVellum({
    fakesOnPath: true,
    extraEnv: { FAKE_HERDR_SCENARIO: scenarioPath },
    seedCanvases: {
      herdr: canvasDoc([
        herdrTextNode({ id: "h1", host: HOST, paneId: PANE_ID, terminalId: TERMINAL_ID, label: LABEL }),
      ]),
    },
  });
  try {
    const { page } = vellum;

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();

    const panel = page.locator(".herdr-terminal-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole("status", { name: "connected" })).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator(".herdr-xterm")).toContainText(FRAME_TEXT.trim(), { timeout: 30_000 });

    await touchTrigger(closeTrigger);

    await expect(panel.locator(".herdr-modal-status")).toContainText("degraded", { timeout: 20_000 });
  } finally {
    await vellum.close();
  }
});
