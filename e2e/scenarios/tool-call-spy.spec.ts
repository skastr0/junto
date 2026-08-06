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
import { launchVellum } from "../harness/launch";
import { expect, test } from "@playwright/test";
import { isValidControlRequestId } from "../../src/shared/browser-control";
import { randomUUID } from "node:crypto";

// Wire contract for process-bind product path: request-id shape, envelope
// shape, and deny without process-bind. Capability ceremony is gone.

const AGENT_LABEL = "e2e spy agent";
const AGENT_KEY = "local:default";
const PAGE_URL = "https://example.org/";
const PROFILE = "work";

test("protected control routes deny without process-bind; request-id contract holds", async () => {
  const vellumCommand = await launchVellum({
    seedCanvases: {
      "tool-call-spy": canvasDoc(
        [
          browserAgentNode({ id: "a1", agentKey: AGENT_KEY, label: AGENT_LABEL }),
          browserPageNode({ id: "p1", url: PAGE_URL, profile: PROFILE }),
        ],
        [{ id: "e1", fromNode: "a1", toNode: "p1" }],
      ),
    },
  });

  try {
    const { page, sandbox } = vellumCommand;
    const socketPath = sandboxControlSocketPath(sandbox.homeDir);
    const token = await readSandboxControlToken(sandbox.homeDir);
    await waitForControlDoctor(socketPath, token);

    const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();
    // No inspector tabs remain — the agent selection surface is the RTS
    // command/kind strip. Browser instructional wall removed; ceremony
    // controls stay absent.
    await expect(page.getByRole("tab", { name: "details" })).toHaveCount(0);
    await expect(page.locator(".inspector-section", { hasText: "browser access" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /enable browser access/i })).toHaveCount(0);

    // Without a registered process, protected routes deny.
    const requestId = randomUUID();
    expect(isValidControlRequestId(requestId)).toBe(true);
    const denied = await controlCall(socketPath, token, "sessions", undefined, {
      requestId,
    });
    expect(denied.envelope.ok).toBe(false);

    // Malformed request id is bad_request (when process-bind would have run).
    const malformed = await controlCall(socketPath, token, "sessions", undefined, {
      requestId: "not-a-request-id",
    });
    // Either 400 bad_request or 401 process-unbound depending on order — both fail closed.
    expect(malformed.envelope.ok).toBe(false);
  } finally {
    await vellumCommand.close();
  }
});
