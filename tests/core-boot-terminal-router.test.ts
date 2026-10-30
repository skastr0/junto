import { mkdtemp, rm } from "node:fs/promises";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { SshTransport } from "../src/main/junto/ssh/service";

const bound = vi.hoisted(() => ({ runner: undefined as undefined | ((effect: unknown) => Promise<unknown>) }));
vi.mock("../src/main/junto/term/router", async (original) => ({
  ...(await original<typeof import("../src/main/junto/term/router")>()),
  configureTerminalRouterLayeredRunner: (runner: (effect: unknown) => Promise<unknown>) => {
    bound.runner = runner;
  },
}));

const { startCore } = await import("../src/main/junto/core");

// The core owns the terminal plane, so the router's SSH dials run on the core's
// own runtime, in the core process and headless alike.
it("binds the terminal router's SSH runner to the core it starts", async () => {
  const home = await mkdtemp("/tmp/junto-core-router-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "a".repeat(64), bundles: {} });
    expect(bound.runner).toBeDefined();
    await expect(bound.runner!(Effect.asVoid(SshTransport))).resolves.toBeUndefined();
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
