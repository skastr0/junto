/** The page side of the loom seed: the version check, no meta, and a failed store. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOM_ROUTER_VERSION, type LoomSeed } from "../src/window/canvas/feed/loom-seed";
import { loadLoomSeed, saveLoomSeed } from "../src/window/canvas/feed/loom-store";

const meta = { routerVersion: LOOM_ROUTER_VERSION, fingerprint: 7, specsKey: "a|b", geometryKey: 3 };
const seed: LoomSeed = { version: LOOM_ROUTER_VERSION, meta: { fingerprint: 7, specsKey: "a|b", geometryKey: 3 }, cards: [], wires: [] };

const stored = (value: { meta: typeof meta | null; cards: LoomSeed["cards"]; wires: LoomSeed["wires"] }) => ({
  load: async () => value,
  save: async () => true,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the loom seed store", () => {
  it("reads a seed at this router version", async () => {
    vi.stubGlobal("window", { junto: { loomSeed: stored({ meta, cards: [], wires: [] }) } });
    expect(await loadLoomSeed("main")).toEqual(seed);
  });

  it("ignores a seed from another router version", async () => {
    vi.stubGlobal("window", {
      junto: { loomSeed: stored({ meta: { ...meta, routerVersion: LOOM_ROUTER_VERSION + 1 }, cards: [], wires: [] }) },
    });
    expect(await loadLoomSeed("main")).toBeUndefined();
  });

  it("ignores a canvas with no seed", async () => {
    vi.stubGlobal("window", { junto: { loomSeed: stored({ meta: null, cards: [], wires: [] }) } });
    expect(await loadLoomSeed("main")).toBeUndefined();
  });

  it("writes the changed rows, and answers a failure", async () => {
    const save = vi.fn(async () => true);
    vi.stubGlobal("window", { junto: { loomSeed: { load: async () => ({ meta: null, cards: [], wires: [] }), save } } });
    const change = { meta: seed.meta, cards: [], wires: [], removedCards: [], removedWires: [] };
    expect(await saveLoomSeed("main", change)).toBe(true);
    expect(save).toHaveBeenCalledWith("main", { ...change, routerVersion: LOOM_ROUTER_VERSION });
    vi.stubGlobal("window", {
      junto: { loomSeed: { load: async () => ({ meta: null, cards: [], wires: [] }), save: async () => { throw new Error("gone"); } } },
    });
    expect(await saveLoomSeed("main", change)).toBe(false);
  });
});
