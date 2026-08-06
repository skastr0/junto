import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneReplyScenario, writeScenario } from "../fakes/hermes-scenario";
import { canvasDoc } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";
import type { TextNode } from "../../src/shared/canvas";

// Real spawn->terminal pipeline against a fake `hermes` on PATH — no demo
// mode. The ACP chat surface is retired product (ACP_CHAT_SURFACE_HIDDEN),
// so the managed terminal is the one agent work surface: double-clicking
// the agent seat spawns the hermes harness (fake `hermes` on the sandbox
// PATH) into the native terminal surface.

const AGENT_KEY = "local:default";
const LABEL = "Fake Hermes Agent";

/** Managed hermes seat — actor-seat law: kind "agent" carries
 * ether.terminal.bindingId + harness so the portfolio compiler admits it. */
const hermesAgentNode = (input: {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}): TextNode => ({
  id: input.id,
  type: "text",
  text: input.label,
  x: 0,
  y: 0,
  width: 240,
  height: 96,
  ether: {
    entity: { kind: "agent", name: input.key },
    host: "local",
    terminal: {
      bindingId: input.key,
      harness: "hermes",
    },
  },
});

test("double-clicking a fake hermes agent opens its managed terminal seat", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-e2e-hermes-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  await writeScenario(scenarioPath, oneReplyScenario("managed-terminal"));

  const vellumCommand = await launchVellum({
    extraEnv: { FAKE_HERMES_SCENARIO: scenarioPath },
    seedCanvases: {
      chat: canvasDoc([hermesAgentNode({ id: "a1", key: AGENT_KEY, label: LABEL })]),
    },
  });
  try {
    const { page } = vellumCommand;

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();

    // Chat attach is retired; the managed terminal is the agent work
    // surface and spawns the hermes harness from the sandbox PATH.
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 20_000 });
    await expect(surface).toContainText(LABEL);
  } finally {
    await vellumCommand.close();
  }
});
