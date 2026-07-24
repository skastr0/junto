import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oneReplyScenario, writeScenario } from "../fakes/hermes-scenario";
import { agentTextNode, canvasDoc } from "../harness/sandbox";
import { expect, launchVellum, test } from "../harness/launch";

// Real spawn->ACP pipeline against a fake `hermes acp` on PATH — no demo
// mode. The canvas node carries ether.entity {kind:"agent", name: AGENT_KEY}
// directly (the same shape src/renderer/lib/node-factories.ts's
// makeAgentNode produces), so opening it mounts the real ChatView without
// depending on the hermes-fleet discovery poll to have landed first.

const AGENT_KEY = "local:default";
const LABEL = "Fake Hermes Agent";
const SCRIPTED_REPLY = "Hello from the fake hermes agent!";

test("attaching chat to a fake hermes agent round-trips a scripted reply", async () => {
  const scenarioDir = await mkdtemp(join(tmpdir(), "vellum-e2e-hermes-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  await writeScenario(scenarioPath, oneReplyScenario(SCRIPTED_REPLY));

  const vellum = await launchVellum({
    extraEnv: { FAKE_HERMES_SCENARIO: scenarioPath },
    seedCanvases: {
      chat: canvasDoc([agentTextNode({ id: "a1", key: AGENT_KEY, label: LABEL })]),
    },
  });
  try {
    const { page } = vellum;

    const node = page.locator(".react-flow__node", { hasText: LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.dblclick();

    await expect(page.locator(".chat-view")).toBeVisible();
    await page.getByRole("button", { name: "attach" }).click();

    const chat = page.locator(".chat-view");
    const composer = chat.getByRole("textbox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await composer.fill("hello there");
    await chat.getByRole("button", { name: "send", exact: true }).click();

    await expect(page.locator(".chat-message--assistant")).toContainText(SCRIPTED_REPLY, { timeout: 30_000 });
  } finally {
    await vellum.close();
  }
});
