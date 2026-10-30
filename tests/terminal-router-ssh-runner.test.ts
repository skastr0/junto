import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { sshTransportRouterRunner } from "../src/main/junto/term/router";
import { SshTransport } from "../src/main/junto/ssh/service";

// Plan A: the terminal plane stays in main, so with the core in its own process
// main's router dials on the SSH transport alone, not on main's runtime.
it("gives main's router a runner on the SSH transport alone when the core runs in its own process", async () => {
  await expect(sshTransportRouterRunner()(Effect.asVoid(SshTransport))).resolves.toBeUndefined();
  const index = readFileSync("src/main/index.ts", "utf8");
  expect(index).toMatch(/configureTerminalRouterLayeredRunner\(CORE_PROCESS_ENABLED\s*\?\s*sshTransportRouterRunner\(\)\s*:\s*\(effect\) => AppRuntime\.runPromise\(effect\)\)/u);
});
