import {
  browserAgentNode,
  browserPageNode,
} from "../harness/browser-automation-fixtures";
import {
  controlCall,
  readSandboxControlToken,
  sandboxControlSocketPath,
  waitForControlDoctor,
} from "../harness/browser-control-client";
import { canvasDoc } from "../harness/sandbox";
import { launchJunto } from "../harness/launch";
import { expect, test } from "@playwright/test";

// Product path: process-bind + human edge — no enable/grant ceremony.
// Agent node edge-connected to a page; control admits only when peer PID
// is registered (ACP open). This e2e proves the UI model and that ceremony
// buttons are gone; full peer-PID admit is covered by unit process-identity tests.

const AGENT_LABEL = "e2e process-bind agent";
const PAGE_URL = "https://example.com/";
const PROFILE = "personal";

test("browser access UI is process-bind + edges; no enable grant ceremony", async () => {
  const junto = await launchJunto({
    seedCanvases: {
      "browser-authorization-granted": canvasDoc([
        browserAgentNode({ id: "a1", agentKey: "local:default", label: AGENT_LABEL }),
        browserPageNode({ id: "p1", url: PAGE_URL, profile: PROFILE }),
      ], [
        { id: "e1", fromNode: "a1", toNode: "p1" },
      ]),
    },
  });

  try {
    const { app, page, sandbox } = junto;
    const socketPath = sandboxControlSocketPath(sandbox.homeDir);
    const token = await readSandboxControlToken(sandbox.homeDir);
    await waitForControlDoctor(socketPath, token);

    const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();
    await expect(node).toHaveClass(/selected/u);

    // The selected-seat inspector is live; ceremony controls stay dead.
    await expect(page.locator(".inspector-section", { hasText: "browser access" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /enable browser access/i })).toHaveCount(0);
    await expect(page.getByText(/no active grants/i)).toHaveCount(0);

    // Transport token alone without process-bind still cannot use protected routes.
    const denied = await controlCall(socketPath, token, "profiles");
    expect(denied.envelope.ok).toBe(false);
  } finally {
    await junto.close();
  }
});
