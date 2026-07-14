import { beforeEach, describe, expect, it, vi } from "vitest";

const runCliMock = vi.fn();

vi.mock("../src/main/vellum/adapters/exec", async () => {
  const actual = await vi.importActual<typeof import("../src/main/vellum/adapters/exec")>(
    "../src/main/vellum/adapters/exec",
  );
  return {
    ...actual,
    runCli: (...args: Parameters<typeof actual.runCli>) => runCliMock(...args),
  };
});

import { fetchTowerBundle } from "../src/main/vellum/adapters/tower";

// --- fixtures --------------------------------------------------------------
//
// Captured live (2026-07-13) from `tower dashboards --json --project vellum
// --project vouch` against the deployed authority — the single bulk call
// that replaced the projects + per-hint dashboard fan-out. Extra unread
// fields (description/gitRemote/metrics/…) kept in to prove they are
// tolerated, not required.

const orbitStates = (building: number, done: number, abandoned: number, backlog = 0) => [
  { state: "backlog", count: backlog },
  { state: "exploring", count: 0 },
  { state: "committed", count: 0 },
  { state: "building", count: building },
  { state: "reviewing", count: 0 },
  { state: "done", count: done },
  { state: "abandoned", count: abandoned },
];

const emptyOrbit = (orbit: string) => ({ orbit, states: orbitStates(0, 0, 0) });

const vellumSummary = {
  project: {
    key: "vellum",
    name: "vellum",
    description: "Desktop station for the portfolio canvas.",
    gitRemote: "https://github.com/skastr0/vellum",
    defaultBranch: "main",
    createdAt: 1783832734544,
    updatedAt: 1783974760898,
  },
  orbits: [
    { orbit: "forge", states: orbitStates(1, 10, 1) },
    emptyOrbit("survey"),
    emptyOrbit("beacon"),
    emptyOrbit("scribe"),
    emptyOrbit("oracle"),
  ],
  signals: { total: 0, inbox: 0, claimed: 0 },
  chatter: { total: 0 },
  metrics: { glyphs: 12, activeGlyphs: 1, doneGlyphs: 10 },
};

const busySummary = {
  project: { key: "vouch", name: "vouch", createdAt: 1780000000000, updatedAt: 1783900000000 },
  orbits: [
    { orbit: "forge", states: orbitStates(2, 31, 0, 10) },
    { orbit: "beacon", states: orbitStates(0, 4, 0) },
    emptyOrbit("survey"),
    emptyOrbit("scribe"),
    emptyOrbit("oracle"),
  ],
  signals: { total: 30, inbox: 5, claimed: 2 },
  chatter: { total: 12 },
};

const envelope = (data: unknown) => ({ ok: true, command: "dashboards", data });

const cliOk = (payload: unknown) => ({ ok: true, stdout: JSON.stringify(payload) });

beforeEach(() => {
  runCliMock.mockReset();
});

describe("fetchTowerBundle (bulk dashboards)", () => {
  it("builds fully-enriched entities from one bulk call", async () => {
    runCliMock.mockResolvedValueOnce(cliOk(envelope([vellumSummary, busySummary])));

    const bundle = await fetchTowerBundle();

    expect(runCliMock).toHaveBeenCalledTimes(1);
    expect(runCliMock).toHaveBeenCalledWith("tower", ["dashboards", "--json"]);
    expect(bundle.ok).toBe(true);
    expect(bundle.entities).toHaveLength(2);

    const vellum = bundle.entities.find((entity) => entity.key === "vellum");
    expect(vellum).toMatchObject({
      source: "tower",
      kind: "project",
      title: "vellum",
      stats: { glyphs_active: 1, glyphs_done: 10, orbits: 1, orbit_forge: 1 },
      updatedAt: new Date(1783974760898).toISOString(),
    });
    // zero totals must not surface as stats keys
    expect(vellum?.stats).not.toHaveProperty("signals");
    expect(vellum?.stats).not.toHaveProperty("chatter");
  });

  it("surfaces signal/chatter totals and multi-orbit rollups when non-zero", async () => {
    runCliMock.mockResolvedValueOnce(cliOk(envelope([busySummary])));

    const bundle = await fetchTowerBundle();
    const vouch = bundle.entities[0];

    expect(vouch.stats).toMatchObject({
      glyphs_active: 12, // forge backlog 10 + building 2
      glyphs_done: 35, // forge 31 + beacon 4
      orbits: 2,
      orbit_forge: 12,
      signals: 30,
      chatter: 12,
    });
    expect(vouch.stats).not.toHaveProperty("orbit_beacon"); // active 0 → omitted
  });

  it("degrades to ok:false when the CLI fails", async () => {
    runCliMock.mockResolvedValueOnce({ ok: false, stdout: "", error: "boom" });

    const bundle = await fetchTowerBundle();

    expect(bundle).toMatchObject({ source: "tower", ok: false, error: "boom", entities: [] });
  });

  it("degrades to explicit ok:false naming the command on malformed JSON", async () => {
    runCliMock.mockResolvedValueOnce({ ok: true, stdout: "not json at all" });

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(false);
    expect(bundle.error).toContain("tower dashboards --json");
    expect(bundle.entities).toEqual([]);
  });

  it("degrades to ok:false when data drifts to a non-array", async () => {
    runCliMock.mockResolvedValueOnce(cliOk(envelope({ projects: [vellumSummary] })));

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(false);
    expect(bundle.error).toContain("tower dashboards --json");
  });

  it("skips malformed rows without taking down the fleet", async () => {
    const drifted = { project: { key: "broken" }, orbits: "nope" };
    runCliMock.mockResolvedValueOnce(cliOk(envelope([drifted, vellumSummary, null, 42])));

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(true);
    expect(bundle.entities).toHaveLength(1);
    expect(bundle.entities[0].key).toBe("vellum");
  });
});
