/** The page side of the loom seed: version check, decode refusal, and a failed store. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOM_ROUTER_VERSION, type LoomSeed } from "../src/window/canvas/feed/loom-seed";
import { loadLoomSeed, saveLoomSeed } from "../src/window/canvas/feed/loom-store";

const seed: LoomSeed = {
  version: LOOM_ROUTER_VERSION,
  geometry: [],
  specs: [],
  obstacles: [],
  facts: [],
  fingerprint: 0,
  corridors: [],
};

const stored = (value: string) => ({ load: async () => ({ routerVersion: LOOM_ROUTER_VERSION, seedJson: value }), save: async () => true });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the loom seed store", () => {
  it("reads a seed at this router version", async () => {
    vi.stubGlobal("window", { junto: { loomSeed: stored(JSON.stringify(seed)) } });
    expect(await loadLoomSeed("main")).toEqual(seed);
  });

  it("ignores a seed from another router version", async () => {
    vi.stubGlobal("window", { junto: { loomSeed: { load: async () => ({ routerVersion: LOOM_ROUTER_VERSION + 1, seedJson: JSON.stringify(seed) }), save: async () => true } } });
    expect(await loadLoomSeed("main")).toBeUndefined();
  });

  it("ignores a seed that does not decode", async () => {
    vi.stubGlobal("window", { junto: { loomSeed: stored("{not json") } });
    expect(await loadLoomSeed("main")).toBeUndefined();
  });

  it("writes the seed at this router version, and answers a failure", async () => {
    const save = vi.fn(async () => true);
    vi.stubGlobal("window", { junto: { loomSeed: { load: async () => null, save } } });
    expect(await saveLoomSeed("main", seed)).toBe(true);
    expect(save).toHaveBeenCalledWith("main", LOOM_ROUTER_VERSION, JSON.stringify(seed));
    vi.stubGlobal("window", { junto: { loomSeed: { load: async () => null, save: async () => { throw new Error("gone"); } } } });
    expect(await saveLoomSeed("main", seed)).toBe(false);
  });
});
