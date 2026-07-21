import {
  controlCall,
  readSandboxControlToken,
  sandboxControlSocketPath,
  waitForControlDoctor,
} from "../harness/browser-control-client";
import { launchVellum } from "../harness/launch";
import { expect, test } from "@playwright/test";

// Process-bind product path denials: transport token without a registered
// process is refused; capability secrets are not identity.

test("agent-side control requests without process-bind are refused", async () => {
  const vellum = await launchVellum({});
  try {
    const { sandbox } = vellum;
    const socketPath = sandboxControlSocketPath(sandbox.homeDir);
    const token = await readSandboxControlToken(sandbox.homeDir);
    await waitForControlDoctor(socketPath, token);

    // 1. Valid transport token, no process-bind — denied on protected route.
    const noBind = await controlCall(socketPath, token, "profiles");
    expect(noBind.envelope.ok).toBe(false);

    // 2. Fabricated capability-shaped secret is not product identity.
    const fabricatedCapability = "A".repeat(43);
    const withCap = await controlCall(socketPath, token, "profiles", undefined, {
      capability: fabricatedCapability,
    });
    expect(withCap.envelope.ok).toBe(false);

    // 3. Wrong transport token refused.
    const wrongToken = await controlCall(socketPath, "0".repeat(64), "doctor");
    expect(wrongToken.envelope.ok).toBe(false);
  } finally {
    await vellum.close();
  }
});
