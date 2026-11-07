/**
 * The core owns the terminal plane, so the router's SSH dials run on the core's
 * own runtime, in the core process and headless alike. The plane hands that
 * runner to the router once, and the router module holds none of its own.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { SshTransport } from "../src/core/ssh/service";
import { HostClientsNoWindow } from "../src/core/host-clients";

const { coreRunner } = await import("../src/core/core-runner");
const { startCore } = await import("../src/core/core");

it("runs the terminal router's SSH dials on the core it starts", async () => {
  const home = await mkdtemp("/tmp/junto-core-router-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ host: HostClientsNoWindow, home, build: "a".repeat(64), bundles: {} });
    // The plane builds the router with this exact runner, and it answers.
    await expect(coreRunner.runPromise(Effect.asVoid(SshTransport))).resolves.toBeUndefined();
    const plane = await readFile(join(import.meta.dirname, "..", "src/core/term/plane.ts"), "utf8");
    expect(plane).toContain("new TerminalRouter(this.host, { layeredRunner: coreRunner.runPromise })");
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
