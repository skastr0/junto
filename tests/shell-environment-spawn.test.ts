import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

// A seat starts only once the shell environment is settled, and records the
// generation it started with: a later change leaves it on the one it had.

const environment = (state: { settled: boolean; generation: number }) => ({
  settled: () => state.settled,
  generation: () => state.generation,
});

describe("a spawn and the shell environment", () => {
  beforeEach(() => seedThisMachine());
  afterEach(() => clearMachines());

  it("cannot run before the shell environment is settled", () => {
    const fake = makeFakeTerminalProcessAuthority();
    const state = { settled: false, generation: 0 };
    const host = new LocalSessionHost(fake.authority, { shellEnvironment: environment(state) });
    expect(() => host.create({ bindingId: "too-early" })).toThrow(/shell environment is not resolved/u);
    expect(fake.controllers).toHaveLength(0);
    state.settled = true;
    expect(host.create({ bindingId: "in-time" }).status).toBe("running");
    expect(fake.controllers).toHaveLength(1);
  });

  it("records the generation each seat started with", () => {
    const fake = makeFakeTerminalProcessAuthority();
    const state = { settled: true, generation: 3 };
    const host = new LocalSessionHost(fake.authority, { shellEnvironment: environment(state) });
    expect(host.create({ bindingId: "before" }).shellEnvironmentGeneration).toBe(3);
    state.generation = 4;
    expect(host.create({ bindingId: "after" }).shellEnvironmentGeneration).toBe(4);
    // The running seat keeps the generation it started with.
    expect(host.get("before")?.shellEnvironmentGeneration).toBe(3);
  });
});
