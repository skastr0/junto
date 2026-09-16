import {
  controlCall,
  readSandboxControlToken,
  sandboxControlSocketPath,
  waitForControlDoctor,
} from "../harness/browser-control-client";
import { launchJunto } from "../harness/launch";
import { expect, test } from "@playwright/test";

// Process-bind product path denial: a transport token without a registered
// process is refused.

test("agent-side control requests without process-bind are refused", async () => {
  const junto = await launchJunto({});
  try {
    const { sandbox } = junto;
    const socketPath = sandboxControlSocketPath(sandbox.homeDir);
    const token = await readSandboxControlToken(sandbox.homeDir);
    await waitForControlDoctor(socketPath, token);

    // Valid transport token, no process-bind — denied on protected route.
    const noBind = await controlCall(socketPath, token, "profiles");
    expect(noBind.envelope.ok).toBe(false);

    // Wrong transport token refused.
    const wrongToken = await controlCall(socketPath, "0".repeat(64), "doctor");
    expect(wrongToken.envelope.ok).toBe(false);
  } finally {
    await junto.close();
  }
});
