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
// All captured live (2026-07-13) against tower CLI v0.1.0 at
// /Users/developer/.local/bin/tower (rebuilt same day — this is the
// contract that replaced `tower status --all --json`).

// `tower projects --json` — data is a BARE ARRAY, trimmed to 3 real rows
// (extra unread fields like description/gitRemote/defaultBranch kept in to
// prove they're tolerated, not required).
const projectsFixture = {
  ok: true,
  command: "projects",
  data: [
    {
      key: "vellum",
      name: "vellum",
      description: "Desktop station for the portfolio canvas.",
      gitRemote: "https://github.com/skastr0/vellum",
      defaultBranch: "main",
      createdAt: 1783832734544,
      updatedAt: 1783971933893,
    },
    {
      key: "vouch",
      name: "vouch",
      description: "Vouch — deployable creator stack.",
      defaultBranch: "main",
      createdAt: 1782794481743,
      updatedAt: 1783876279957,
    },
    {
      key: "openclaw",
      name: "openclaw",
      createdAt: 1783181115180,
      updatedAt: 1783181115180,
    },
  ],
};

// `tower dashboard --json vellum` — trimmed to project/orbits/signals/chatter
// (the fields the adapter reads). forge: building=2, done=9, abandoned=1;
// all other orbits are present-but-zero (the fixed 5-orbit set every project
// gets back regardless of usage).
const zeroOrbit = (orbit: string) => ({
  orbit,
  states: [
    { state: "backlog", count: 0 },
    { state: "exploring", count: 0 },
    { state: "committed", count: 0 },
    { state: "building", count: 0 },
    { state: "reviewing", count: 0 },
    { state: "done", count: 0 },
    { state: "abandoned", count: 0 },
  ],
});

const vellumDashboardFixture = {
  ok: true,
  command: "dashboard",
  data: {
    project: { key: "vellum", name: "vellum", updatedAt: 1783971933893 },
    orbits: [
      {
        orbit: "forge",
        states: [
          { state: "backlog", count: 0 },
          { state: "exploring", count: 0 },
          { state: "committed", count: 0 },
          { state: "building", count: 2 },
          { state: "reviewing", count: 0 },
          { state: "done", count: 9 },
          { state: "abandoned", count: 1 },
        ],
      },
      zeroOrbit("survey"),
      zeroOrbit("beacon"),
      zeroOrbit("scribe"),
      zeroOrbit("oracle"),
    ],
    signals: [],
    chatter: [],
  },
};

// `tower dashboard --json vouch` — forge: backlog=10, reviewing=2, done=31,
// abandoned=74; signals has 30 items (full item-list array, not a
// {present,fileCount} counter).
const vouchDashboardFixture = {
  ok: true,
  command: "dashboard",
  data: {
    project: { key: "vouch", name: "vouch", updatedAt: 1783876279957 },
    orbits: [
      {
        orbit: "forge",
        states: [
          { state: "backlog", count: 10 },
          { state: "exploring", count: 0 },
          { state: "committed", count: 0 },
          { state: "building", count: 0 },
          { state: "reviewing", count: 2 },
          { state: "done", count: 31 },
          { state: "abandoned", count: 74 },
        ],
      },
      zeroOrbit("survey"),
      zeroOrbit("beacon"),
      zeroOrbit("scribe"),
      zeroOrbit("oracle"),
    ],
    signals: new Array(30).fill({}),
    chatter: [],
  },
};

const ok = (payload: unknown) => ({ ok: true, stdout: JSON.stringify(payload) });
const fail = (error: string) => ({ ok: false, stdout: "", error });

const mockRoute = (routes: {
  projects?: ReturnType<typeof ok> | ReturnType<typeof fail>;
  dashboard?: (key: string) => ReturnType<typeof ok> | ReturnType<typeof fail>;
}) => {
  runCliMock.mockImplementation(async (command: string, args: ReadonlyArray<string>) => {
    if (command === "tower" && args[0] === "projects") {
      return routes.projects ?? fail("unexpected: no projects route configured");
    }
    if (command === "tower" && args[0] === "dashboard") {
      const key = args[args.length - 1];
      return routes.dashboard?.(key) ?? fail(`unexpected dashboard call for ${key}`);
    }
    throw new Error(`unexpected runCli call: ${command} ${args.join(" ")}`);
  });
};

beforeEach(() => {
  runCliMock.mockReset();
});

describe("fetchTowerBundle — projects parse", () => {
  it("maps the bare-array `tower projects --json` payload into minimal base entities", async () => {
    mockRoute({ projects: ok(projectsFixture) });

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(true);
    expect(bundle.source).toBe("tower");
    expect(bundle.entities).toHaveLength(3);

    const vellum = bundle.entities.find((e) => e.key === "vellum");
    expect(vellum).toEqual({
      source: "tower",
      key: "vellum",
      kind: "project",
      title: "vellum",
      stats: {},
      updatedAt: new Date(1783971933893).toISOString(),
    });
  });

  it("degrades to ok:false naming the failing CLI invocation when the process errors", async () => {
    runCliMock.mockResolvedValue(fail("Received unknown argument: '--all'"));

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(false);
    expect(bundle.entities).toEqual([]);
    expect(bundle.error).toBe("Received unknown argument: '--all'");
  });
});

describe("fetchTowerBundle — dashboard enrichment math", () => {
  it("folds glyphs_active/glyphs_done/orbits/orbit_<name>/signals into the hinted entity", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: (key) => {
        if (key === "vouch") return ok(vouchDashboardFixture);
        return fail(`no dashboard fixture for ${key}`);
      },
    });

    const bundle = await fetchTowerBundle(["vouch"]);

    expect(bundle.ok).toBe(true);
    const vouch = bundle.entities.find((e) => e.key === "vouch");
    expect(vouch?.stats).toEqual({
      glyphs_active: 12, // backlog 10 + reviewing 2
      glyphs_done: 31,
      orbits: 1, // only forge has any activity; the other 4 are present-but-zero
      orbit_forge: 12,
      signals: 30,
      // chatter omitted: length is 0
    });
  });

  it("omits signals/chatter stats entirely when their arrays are empty", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: (key) => (key === "vellum" ? ok(vellumDashboardFixture) : fail("n/a")),
    });

    const bundle = await fetchTowerBundle(["vellum"]);

    const vellum = bundle.entities.find((e) => e.key === "vellum");
    expect(vellum?.stats).toEqual({
      glyphs_active: 2, // building 2 (abandoned 1 excluded)
      glyphs_done: 9,
      orbits: 1,
      orbit_forge: 2,
    });
    expect(vellum?.stats.signals).toBeUndefined();
    expect(vellum?.stats.chatter).toBeUndefined();
  });

  it("dedupes and caps hinted keys at 8, issuing at most 8 dashboard calls", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: () => ok(vellumDashboardFixture),
    });

    const manyHints = [
      "a",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j", // 10 distinct keys after dedup; cap is 8
    ];
    await fetchTowerBundle(manyHints);

    const dashboardCalls = runCliMock.mock.calls.filter(
      ([command, args]) => command === "tower" && args[0] === "dashboard",
    );
    expect(dashboardCalls).toHaveLength(8);
  });
});

describe("fetchTowerBundle — drift armor", () => {
  it("returns ok:false naming the command when `tower projects --json` data is an object, not an array", async () => {
    mockRoute({
      // Old envelope shape `{projects: [...]}` — the exact drift this adapter
      // was fixed for. Must NOT silently map to entities:[].
      projects: ok({ ok: true, command: "projects", data: { projects: [] } }),
    });

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(false);
    expect(bundle.entities).toEqual([]);
    expect(bundle.error).toContain("tower projects");
  });

  it("degrades the whole bundle to ok:false when `tower projects --json` returns malformed JSON", async () => {
    mockRoute({ projects: { ok: true, stdout: "not json" } });

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(false);
    expect(bundle.entities).toEqual([]);
  });

  it("skips malformed rows in the projects array instead of throwing", async () => {
    mockRoute({
      projects: ok({
        ok: true,
        command: "projects",
        data: [
          { key: "vellum", name: "vellum", updatedAt: 1783832734544 },
          { key: "broken-row" /* missing name/updatedAt */ },
          "not-even-an-object",
        ],
      }),
    });

    const bundle = await fetchTowerBundle();

    expect(bundle.ok).toBe(true);
    expect(bundle.entities.map((e) => e.key)).toEqual(["vellum"]);
  });

  it("degrades a single hint to a no-op (base entity survives) when dashboard.orbits is an object instead of an array", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: (key) =>
        key === "vellum"
          ? ok({
              ok: true,
              command: "dashboard",
              data: { project: { name: "vellum" }, orbits: { forge: { building: 2 } } },
            })
          : fail("n/a"),
    });

    const bundle = await fetchTowerBundle(["vellum"]);

    expect(bundle.ok).toBe(true);
    const vellum = bundle.entities.find((e) => e.key === "vellum");
    expect(vellum?.stats).toEqual({}); // base entity, untouched
  });

  it("degrades a single hint to a no-op when an orbit state entry is missing `count`", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: (key) =>
        key === "vellum"
          ? ok({
              ok: true,
              command: "dashboard",
              data: {
                project: { name: "vellum" },
                orbits: [{ orbit: "forge", states: [{ state: "building" /* no count */ }] }],
              },
            })
          : fail("n/a"),
    });

    const bundle = await fetchTowerBundle(["vellum"]);

    const vellum = bundle.entities.find((e) => e.key === "vellum");
    expect(vellum?.stats).toEqual({});
  });
});

describe("fetchTowerBundle — hint failure never fails the bundle", () => {
  it("keeps the base entity (and bundle ok:true) when the dashboard CLI call for a hinted key fails", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: () => fail("Project 'vellum' does not exist."), // e.g. a 404
    });

    const bundle = await fetchTowerBundle(["vellum"]);

    expect(bundle.ok).toBe(true);
    const vellum = bundle.entities.find((e) => e.key === "vellum");
    expect(vellum).toEqual({
      source: "tower",
      key: "vellum",
      kind: "project",
      title: "vellum",
      stats: {},
      updatedAt: new Date(1783971933893).toISOString(),
    });
  });

  it("never throws even when every CLI call fails", async () => {
    runCliMock.mockResolvedValue(fail("boom"));
    await expect(fetchTowerBundle(["vellum", "vouch"])).resolves.toMatchObject({ ok: false });
  });

  it("creates a fresh entity from the dashboard payload when a hinted key isn't in the base projects list", async () => {
    mockRoute({
      projects: ok(projectsFixture),
      dashboard: (key) => (key === "not-in-base-list" ? ok(vellumDashboardFixture) : fail("n/a")),
    });

    const bundle = await fetchTowerBundle(["not-in-base-list"]);

    expect(bundle.ok).toBe(true);
    const entity = bundle.entities.find((e) => e.key === "not-in-base-list");
    expect(entity?.title).toBe("vellum"); // falls back to dashboard's project.name
    expect(entity?.stats.glyphs_active).toBe(2);
  });
});
