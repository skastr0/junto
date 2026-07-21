import { randomUUID } from "node:crypto";
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
import { isValidControlCapability, isValidControlRequestId } from "../../src/shared/browser-control";

// The agent-visible surface: after a real grant round trip, capture the
// control envelope of a real agent-side tool call and check it against the
// wire contract in src/shared/browser-control.ts — capability header shape,
// request-id header shape, and the ok/error envelope discriminant — rather
// than trusting any one client's happy path.

const AGENT_LABEL = "e2e spy agent";
const AGENT_KEY = "local:default";
const PAGE_URL = "https://example.org/";
const PROFILE = "work";

test("a real agent-side round trip carries a contract-shaped capability header and request id", async () => {
  const dumpDir = await mkdtemp(join(tmpdir(), "vellum-e2e-browser-spy-"));
  const dumpPath = join(dumpDir, "capability.json");

  const vellum = await launchVellum({
    extraEnv: { FAKE_HERMES_BROWSER_CAPABILITY_DUMP: dumpPath },
    seedCanvases: {
      "tool-call-spy": canvasDoc([
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
    await patchBrowserAutomationDialogApproval(app, 1);

    const node = page.locator(".react-flow__node", { hasText: AGENT_LABEL });
    await expect(node).toBeVisible({ timeout: 30_000 });
    await node.click();
    await page.getByRole("tab", { name: "details" }).click();
    const section = page.locator(".inspector-section", { hasText: "browser automation" });
    await section.getByRole("button", { name: "enable browser access" }).click();

    const delivered = await waitForCapabilityDump(dumpPath, 30_000);
    const capability = delivered.capability;
    expect(capability).not.toBeNull();
    if (capability === null) return;

    // 1. The delivered capability itself matches the wire contract's shape
    //    predicate (32 random bytes, unpadded base64url — src/shared/browser-control.ts).
    expect(isValidControlCapability(capability)).toBe(true);

    // 2. A real round trip with a well-formed request id + the delivered
    //    capability succeeds and decodes as a contract-shaped ok envelope.
    const requestId = randomUUID();
    expect(isValidControlRequestId(requestId)).toBe(true);
    const ok = await controlCall(socketPath, token, "sessions", undefined, {
      capability,
      requestId,
    });
    expect(ok.status).toBe(200);
    expect(ok.envelope).toMatchObject({ ok: true });
    if (ok.envelope.ok) {
      expect(Array.isArray(ok.envelope.data)).toBe(true);
    }

    // 3. A malformed request id is rejected as bad_request before the
    //    capability is even consulted for scope — the header contract is
    //    enforced independently of the capability's validity.
    const malformedRequestId = await controlCall(socketPath, token, "sessions", undefined, {
      capability,
      requestId: "not-a-request-id",
    });
    expect(malformedRequestId.status).toBe(400);
    expect(malformedRequestId.envelope.ok).toBe(false);
    if (!malformedRequestId.envelope.ok) {
      expect(malformedRequestId.envelope.error._tag).toBe("bad_request");
    }

    // 4. A syntactically valid but never-issued capability is still denied —
    //    header shape passing isValidControlCapability is necessary, not
    //    sufficient, for the server to grant access.
    const neverIssuedCapability = capability.slice(0, -1) + (capability.endsWith("A") ? "B" : "A");
    expect(isValidControlCapability(neverIssuedCapability)).toBe(true);
    expect(neverIssuedCapability).not.toBe(capability);
    const deniedShapeValid = await controlCall(socketPath, token, "sessions", undefined, {
      capability: neverIssuedCapability,
      requestId: randomUUID(),
    });
    expect(deniedShapeValid.status).toBe(401);
    expect(deniedShapeValid.envelope.ok).toBe(false);
  } finally {
    await vellum.close();
  }
});
