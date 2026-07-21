import { browserAgentNode } from "../harness/browser-automation-fixtures";
import {
  controlCall,
  readSandboxControlToken,
  sandboxControlSocketPath,
  waitForControlDoctor,
} from "../harness/browser-control-client";
import { canvasDoc } from "../harness/sandbox";
import { expect, test } from "../harness/launch";

// The agent-tools authorization plane, denial path: a control-plane request
// with no capability at all is refused, and a request whose transport token
// is wrong is refused before even reaching route dispatch — both real round
// trips against the app's own control socket (src/main/vellum/browser/control.ts),
// never mocked. The UI side confirms the inspector shows no active grants
// for an otherwise-eligible subject node.

const AGENT_LABEL = "e2e denied agent";

test.use({
  vellumOptions: {
    seedCanvases: {
      "browser-authorization-denied": canvasDoc([
        browserAgentNode({ id: "a1", agentKey: "local:default", label: AGENT_LABEL }),
      ]),
    },
  },
});

test("agent-side control requests without a valid grant or token are refused", async ({ vellum }) => {
  const { page, sandbox } = vellum;
  const socketPath = sandboxControlSocketPath(sandbox.homeDir);
  const token = await readSandboxControlToken(sandbox.homeDir);

  // Control plane is up and reachable at the sandboxed home (never the
  // operator's real ~/.vellum) before we start asserting denials.
  await waitForControlDoctor(socketPath, token);

  // 1. Valid transport token, no capability header at all — the "no grant"
  //    half of the contract.
  const noCapability = await controlCall(socketPath, token, "profiles");
  expect(noCapability.status).toBe(401);
  expect(noCapability.envelope.ok).toBe(false);
  if (!noCapability.envelope.ok) {
    expect(noCapability.envelope.error._tag).toBe("unauthorized");
  }

  // 2. A capability-shaped but never-issued value — still denied, proving
  //    the server checks issuance, not just header shape.
  const fabricatedCapability = "A".repeat(43);
  const fakeCapability = await controlCall(socketPath, token, "profiles", undefined, {
    capability: fabricatedCapability,
  });
  expect(fakeCapability.status).toBe(401);
  expect(fakeCapability.envelope.ok).toBe(false);

  // 3. Wrong transport token entirely — the "no token" half of the contract,
  //    refused before route dispatch even considers a capability.
  const wrongToken = await controlCall(socketPath, "not-the-real-token", "doctor");
  expect(wrongToken.status).toBe(401);
  expect(wrongToken.envelope.ok).toBe(false);
  if (!wrongToken.envelope.ok) {
    expect(wrongToken.envelope.error._tag).toBe("unauthorized");
  }

  // UI side: select the eligible-but-never-granted agent node and confirm
  // the inspector's browser-automation section shows no active grants.
  const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
  await expect(node).toBeVisible({ timeout: 30_000 });
  await node.click();

  // Agent nodes read chat-first (InspectorPanel.tsx AgentTabBar): browser
  // automation lives under "details", not the default "chat" tab.
  await page.getByRole("tab", { name: "details" }).click();

  const section = page.locator(".inspector-section", { hasText: "browser automation" });
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText("no active grants")).toBeVisible({ timeout: 30_000 });
  await expect(section.locator(".inspector-binding")).toHaveCount(0);
});
