import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneReplyScenario, writeScenario } from "../fakes/hermes-scenario";
import { modelFixture, modelNode } from "../harness/model";
import { expect, launchJunto, test } from "../harness/launch";

// Real spawn->terminal pipeline against a fake `hermes` on PATH — no demo
// mode. The ACP chat surface is retired product (ACP_CHAT_SURFACE_HIDDEN),
// so the managed terminal is the one agent work surface: double-clicking
// the agent seat spawns the hermes harness (fake `hermes` on the sandbox
// PATH) into the native terminal surface.

const AGENT_KEY = "local:default";
const LABEL = "Fake Hermes Agent";

/** The native seat names a stable binding and its harness. */
const hermesAgentNode = (input: {
  readonly id: string; readonly key: string; readonly label: string;
}) => modelNode({
  kind: "agent", id: input.id, agentKey: input.key, label: input.label,
  bindingId: input.key, harness: "hermes", host: "local", overseer: false, onRemove: "detach",
  x: 0, y: 0, width: 240, height: 96, z: 0,
});

test("double-clicking a fake hermes agent opens its managed terminal seat", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "junto-e2e-hermes-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  await writeScenario(scenarioPath, oneReplyScenario("managed-terminal"));

  const junto = await launchJunto({
    extraEnv: { FAKE_HERMES_SCENARIO: scenarioPath },
    seedModels: {
      chat: modelFixture([hermesAgentNode({ id: "a1", key: AGENT_KEY, label: LABEL })]),
    },
  });
  try {
    const { page } = junto;

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();

    // Chat attach is retired; the managed terminal is the agent work
    // surface and spawns the hermes harness from the sandbox PATH.
    const surface = page.locator(".native-terminal-surface");
    await expect(surface).toBeVisible({ timeout: 20_000 });
    await expect(surface).toContainText(LABEL);
  } finally {
    await junto.close();
  }
});
