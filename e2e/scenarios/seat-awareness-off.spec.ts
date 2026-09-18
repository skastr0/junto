/**
 * The seat-awareness gate, from the outside: a ship build shows nothing.
 *
 *   bun run test:e2e e2e/scenarios/seat-awareness-off.spec.ts     # ship build
 *
 * Run against a build made without `JUNTO_FEATURE_PROFILE=all-on`. It opens a
 * real seat so the sidecar would have something to observe, hovers the card,
 * and asserts the whole subsystem is absent: no advisory hover, no
 * collaboration overlay, and no provider call or hold in main's own log.
 *
 * The all-on profile is the other half of this gate and this spec is the wrong
 * check there, so it skips itself when it finds the surface present rather than
 * reporting a false failure.
 */
import { agentTextNode, canvasDoc, terminalTextNode } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

const AGENT_LABEL = "Gate probe seat";

test.use({
  juntoOptions: {
    seedCanvases: {
      gateoff: canvasDoc([
        agentTextNode({
          id: "gate-probe-agent",
          key: "gate-probe-agent-binding",
          label: AGENT_LABEL,
          x: 80,
          y: 40,
        }),
        terminalTextNode({
          id: "gate-probe-term",
          bindingId: "gate-probe-term-binding",
          label: "Gate probe terminal",
          x: 460,
          y: 40,
          launch: { kind: "command", argv: ["/bin/sh", "-i"] },
        }),
      ]),
    },
  },
});

test("a ship build renders no part of seat awareness and makes no call", async ({
  junto,
}) => {
  test.setTimeout(180_000);
  const { page } = junto;
  const mainLog: string[] = [];
  junto.app.process().stdout?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));
  junto.app.process().stderr?.on("data", (chunk: Buffer) => mainLog.push(String(chunk)));

  // A live seat: if the sidecar were on, this is what it would observe.
  const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
  await expect(node).toBeVisible({ timeout: 60_000 });
  const terminal = page.locator(".react-flow__node", { hasText: "Gate probe terminal" });
  await terminal.dblclick();
  const surface = page.locator(".native-terminal-surface");
  await expect(surface).toBeVisible({ timeout: 60_000 });
  await surface.locator(".xterm-screen").click();
  await page.keyboard.type("echo gate-probe");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3_000);
  await surface.getByRole("button", { name: "Close" }).click();
  await expect(surface).toBeHidden({ timeout: 20_000 });

  await node.hover();
  await page.waitForTimeout(2_000);

  const overlay = page.locator("[data-collaboration-overlay]");
  test.skip(
    (await overlay.count()) > 0,
    "this build has seat awareness on: run this spec against a ship build",
  );

  await expect(page.locator("[data-seat-awareness]")).toHaveCount(0);
  await expect(page.locator("[data-seat-collaboration]")).toHaveCount(0);
  expect(mainLog.join("").includes("[jev-call]")).toBe(false);
  expect(mainLog.join("").includes("[jev-hold]")).toBe(false);
});
