import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserAgentNode,
  browserPageNode,
  patchBrowserAutomationDialogApproval,
  waitForCapabilityDump,
} from "../harness/browser-automation-fixtures";
import {
  controlCall,
  readSandboxControlToken,
  sandboxControlSocketPath,
  waitForControlDoctor,
} from "../harness/browser-control-client";
import { canvasDoc } from "../harness/sandbox";
import { launchVellum } from "../harness/launch";
import { expect, test } from "@playwright/test";

// Drives the real product grant flow end to end: native-dialog approval
// (stubbed via app.evaluate — the confirmation itself,
// src/main/index.ts confirmBrowserAutomation, is untouched product code),
// the grant appearing in the inspector's "active access" list, an
// agent-side control-plane round trip succeeding with the delivered
// capability, then revoke removing both the UI grant and control-plane
// access. extraEnv (the capability-dump path) is per-test, so this spec
// drives launchVellum directly rather than the `vellum` fixture.

const AGENT_LABEL = "e2e granted agent";
const AGENT_KEY = "local:default";
const PAGE_URL = "https://example.com/";
const PROFILE = "personal";

test("approving the native grant dialog authorizes a real agent-side control-plane round trip, and revoke ends it", async () => {
  const dumpDir = await mkdtemp(join(tmpdir(), "vellum-e2e-browser-cap-"));
  const dumpPath = join(dumpDir, "capability.json");

  const vellum = await launchVellum({
    extraEnv: { FAKE_HERMES_BROWSER_CAPABILITY_DUMP: dumpPath },
    seedCanvases: {
      "browser-authorization-granted": canvasDoc([
        browserAgentNode({ id: "a1", agentKey: AGENT_KEY, label: AGENT_LABEL }),
        browserPageNode({ id: "p1", url: PAGE_URL, profile: PROFILE }),
      ]),
    },
  });

  try {
    const { app, page, sandbox } = vellum;
    const socketPath = sandboxControlSocketPath(sandbox.homeDir);
    const token = await readSandboxControlToken(sandbox.homeDir);
    await waitForControlDoctor(socketPath, token);

    // Empirical proof the dialog patch takes effect through the bundled
    // main-process import: approve before any grant is requested.
    await patchBrowserAutomationDialogApproval(app, 1);

    const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();

    // Agent nodes read chat-first (InspectorPanel.tsx AgentTabBar): browser
    // automation lives under "details", not the default "chat" tab.
    await page.getByRole("tab", { name: "details" }).click();

    const section = page.locator(".inspector-section", { hasText: "browser automation" });
    await expect(section).toBeVisible({ timeout: 30_000 });
    await expect(section.getByText("no active grants")).toBeVisible({ timeout: 30_000 });

    await section.getByRole("button", { name: "enable browser access" }).click();

    // The only observable proof the confirmation was actually approved and
    // delivery happened: the fake hermes child (spawned by
    // chatRestartWithLocalBrowserAuthority) received real browser-authority
    // env vars and dumped them.
    const delivered = await waitForCapabilityDump(dumpPath, 30_000);
    expect(delivered.capability).not.toBeNull();
    expect(delivered.home).toBe(sandbox.homeDir);

    const grantRow = section.locator(".inspector-binding", { hasText: "Hermes" });
    await expect(grantRow).toBeVisible({ timeout: 30_000 });
    await expect(section.getByText("no active grants")).toHaveCount(0);

    // Agent-side control request now succeeds with the delivered capability.
    const capability = delivered.capability as string;
    const authorized = await controlCall(socketPath, token, "profiles", undefined, { capability });
    expect(authorized.status).toBe(200);
    expect(authorized.envelope.ok).toBe(true);
    if (authorized.envelope.ok) {
      const rows = authorized.envelope.data as ReadonlyArray<{ id: string }>;
      expect(rows.some((row) => row.id === PROFILE)).toBe(true);
    }

    // Revoke: UI removes the grant, and the capability is denied thereafter.
    await grantRow.getByRole("button", { name: /revoke/ }).click();
    await expect(grantRow).toHaveCount(0, { timeout: 30_000 });
    await expect(section.getByText("no active grants")).toBeVisible({ timeout: 30_000 });

    const afterRevoke = await controlCall(socketPath, token, "profiles", undefined, { capability });
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.envelope.ok).toBe(false);
  } finally {
    await vellum.close();
  }
});
