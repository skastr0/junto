import { afterEach, describe, expect, it, vi } from "vitest";
import type { EtherView } from "../src/shared/canvas";
import type {
  QuasarSessionDetail,
  QuasarSessionsResult,
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerGlyphRow,
  TowerSignalRow,
} from "../src/shared/ipc";
import {
  BROWSE_CACHE_TTL_MS,
  CANONICAL_ORBITS,
  compileGlyphQuery,
  fetchQuasarSessionDetail,
  fetchQuasarSessions,
  fetchTowerBrowse,
  fetchTowerDispatches,
  fetchTowerGlyphRead,
  fetchTowerSearch,
  fetchTowerSignalRead,
  invalidateTowerBrowse,
  filterGlyphsByOrbit,
  filterGlyphsByView,
  filterSignalsByView,
  formatCollapsedSummary,
  formatDuration,
  glyphStateHue,
  groupGlyphs,
  orbitOptions,
  orbitsPresent,
  sessionDetailStats,
  sessionDurationOrDates,
  sessionStats,
  sessionTitle,
  shortDate,
  shortKind,
  signalStatusHue,
  TOWER_STATES,
} from "../src/renderer/lib/browse";

const glyph = (state: string, glyphId = `g-${state}`): TowerGlyphRow => ({
  glyphId,
  orbit: "forge",
  title: `title for ${state}`,
  state,
  updatedAt: 0,
});

describe("glyph grouping", () => {
  it("sorts active states in priority order and collapses done/abandoned into counts", () => {
    const glyphs = [
      glyph("backlog"),
      glyph("done", "d1"),
      glyph("building"),
      glyph("done", "d2"),
      glyph("exploring"),
      glyph("abandoned"),
      glyph("reviewing"),
      glyph("committed"),
    ];
    const { visible, collapsedRows, collapsedCounts } = groupGlyphs(glyphs);
    expect(visible.map((g) => g.state)).toEqual(["building", "reviewing", "committed", "exploring", "backlog"]);
    expect(collapsedRows).toHaveLength(3);
    expect(collapsedCounts).toEqual([
      { state: "done", count: 2 },
      { state: "abandoned", count: 1 },
    ]);
    expect(formatCollapsedSummary(collapsedCounts)).toBe("2 done · 1 abandoned");
  });

  it("omits a collapsed count when its state is absent", () => {
    const { collapsedCounts } = groupGlyphs([glyph("building"), glyph("done")]);
    expect(collapsedCounts).toEqual([{ state: "done", count: 1 }]);
  });

  it("surfaces unrecognized states instead of dropping them", () => {
    const { visible } = groupGlyphs([glyph("mystery"), glyph("building")]);
    expect(visible.map((g) => g.state)).toEqual(["building", "mystery"]);
  });
});

describe("state hues", () => {
  it("colors building/reviewing amber, done green, everything else dim", () => {
    expect(glyphStateHue("building")).toBe("#E8A33D");
    expect(glyphStateHue("reviewing")).toBe("#E8A33D");
    expect(glyphStateHue("done")).toBe("#5FB98E");
    expect(glyphStateHue("committed")).not.toBe("#E8A33D");
    expect(glyphStateHue("abandoned")).not.toBe("#5FB98E");
  });

  it("colors signal status by inbox/claimed/dead/consumed", () => {
    expect(signalStatusHue("inbox")).toBe("#E8A33D");
    expect(signalStatusHue("claimed")).toBe("#39C6D6");
    expect(signalStatusHue("dead")).toBe("#E5484D");
    expect(signalStatusHue("consumed")).not.toBe("#E5484D");
  });
});

describe("project view slices", () => {
  const signal = (orbit: string, status = "inbox"): TowerSignalRow => ({
    signalId: `sig-${orbit}`,
    orbit,
    status,
    kind: "test.kind",
    summary: `signal in ${orbit}`,
    updatedAt: 0,
  });

  it("exposes the full 7-state tower vocabulary and canonical five orbits", () => {
    expect(TOWER_STATES).toEqual(["backlog", "exploring", "committed", "building", "reviewing", "done", "abandoned"]);
    expect(CANONICAL_ORBITS).toEqual(["forge", "survey", "beacon", "scribe", "oracle"]);
  });

  it("merges canonical orbits with discovered orbit_<name> stat keys, deduped", () => {
    expect(orbitOptions(undefined)).toEqual(CANONICAL_ORBITS);
    expect(orbitOptions({ orbit_forge: 3, orbit_lattice: 1, glyphs_active: 9 })).toEqual([
      "forge",
      "survey",
      "beacon",
      "scribe",
      "oracle",
      "lattice",
    ]);
  });

  describe("compileGlyphQuery", () => {
    it("matches by case-insensitive substring when not wrapped in slashes", () => {
      const test = compileGlyphQuery("BUG");
      expect(test("fix the bug report")).toBe(true);
      expect(test("unrelated")).toBe(false);
    });

    it("compiles a /regex/ pattern when it parses", () => {
      const test = compileGlyphQuery("/^fix-\\d+$/i");
      expect(test("FIX-42")).toBe(true);
      expect(test("fix-abc")).toBe(false);
    });

    it("degrades an invalid regex to a plain substring match instead of matching nothing", () => {
      const test = compileGlyphQuery("/unclosed[/");
      expect(test("prefix /unclosed[/ suffix")).toBe(true);
      expect(test("no match here")).toBe(false);
    });

    it("matches everything for an empty/blank query", () => {
      const test = compileGlyphQuery("   ");
      expect(test("anything")).toBe(true);
    });
  });

  describe("filterGlyphsByView", () => {
    const glyphs: ReadonlyArray<TowerGlyphRow> = [
      { glyphId: "g-1", orbit: "forge", title: "fix the parser", state: "building", updatedAt: 0 },
      { glyphId: "g-2", orbit: "beacon", title: "launch copy", state: "backlog", updatedAt: 0 },
      { glyphId: "bug-3", orbit: "forge", title: "done thing", state: "done", updatedAt: 0 },
    ];

    it("passes every glyph through when there is no view", () => {
      expect(filterGlyphsByView(glyphs, undefined)).toEqual(glyphs);
    });

    it("narrows by orbit", () => {
      const view: EtherView = { orbit: "forge" };
      expect(filterGlyphsByView(glyphs, view).map((g) => g.glyphId)).toEqual(["g-1", "bug-3"]);
    });

    it("narrows by a states set", () => {
      const view: EtherView = { states: ["backlog", "done"] };
      expect(filterGlyphsByView(glyphs, view).map((g) => g.glyphId)).toEqual(["g-2", "bug-3"]);
    });

    it("narrows by glyphQuery matched against id and title", () => {
      const view: EtherView = { glyphQuery: "bug" };
      expect(filterGlyphsByView(glyphs, view).map((g) => g.glyphId)).toEqual(["bug-3"]);
    });

    it("composes orbit, states, and glyphQuery together", () => {
      const view: EtherView = { orbit: "forge", states: ["building"], glyphQuery: "parser" };
      expect(filterGlyphsByView(glyphs, view).map((g) => g.glyphId)).toEqual(["g-1"]);
    });
  });

  describe("filterSignalsByView", () => {
    const signals: ReadonlyArray<TowerSignalRow> = [signal("forge"), signal("beacon")];

    it("passes every signal through without a view or without view.orbit", () => {
      expect(filterSignalsByView(signals, undefined)).toEqual(signals);
      expect(filterSignalsByView(signals, {})).toEqual(signals);
    });

    it("narrows signals to the view's orbit only", () => {
      expect(filterSignalsByView(signals, { orbit: "forge" }).map((s) => s.signalId)).toEqual(["sig-forge"]);
    });
  });

  describe("orbit chip narrowing", () => {
    const glyphs: ReadonlyArray<TowerGlyphRow> = [
      { glyphId: "g-1", orbit: "forge", title: "a", state: "building", updatedAt: 0 },
      { glyphId: "g-2", orbit: "beacon", title: "b", state: "backlog", updatedAt: 0 },
      { glyphId: "g-3", orbit: "forge", title: "c", state: "done", updatedAt: 0 },
    ];

    it("lists every orbit present in the glyph list, deduped and sorted", () => {
      expect(orbitsPresent(glyphs)).toEqual(["beacon", "forge"]);
    });

    it("passes glyphs through unfiltered for an undefined/empty orbit ('all')", () => {
      expect(filterGlyphsByOrbit(glyphs, undefined)).toEqual(glyphs);
      expect(filterGlyphsByOrbit(glyphs, "")).toEqual(glyphs);
    });

    it("narrows to a single orbit", () => {
      expect(filterGlyphsByOrbit(glyphs, "forge").map((g) => g.glyphId)).toEqual(["g-1", "g-3"]);
    });
  });
});

describe("row formatting helpers", () => {
  it("shortens a dotted kind to its last segment and preserves the full string for a title", () => {
    expect(shortKind("tower.signal.dispatched")).toBe("dispatched");
    expect(shortKind("noop")).toBe("noop");
  });

  it("falls back to '<provider> session' when a session has no title", () => {
    const base = { sessionId: "s1", provider: "claude", messageCount: 4, toolCallCount: 2 } as const;
    expect(sessionTitle({ ...base, title: undefined })).toBe("claude session");
    expect(sessionTitle({ ...base, title: "Refactor auth" })).toBe("Refactor auth");
    expect(sessionStats(base)).toBe("4msg · 2tools");
  });

  it("formats a short date and rejects garbage", () => {
    expect(shortDate("2026-03-04T00:00:00Z")).toMatch(/mar/);
    expect(shortDate(undefined)).toBeUndefined();
    expect(shortDate("not-a-date")).toBeUndefined();
  });
});

describe("session detail formatting", () => {
  const detail = (overrides: Partial<QuasarSessionDetail> = {}): QuasarSessionDetail => ({
    sessionId: "s1",
    provider: "claude",
    messageCount: 12,
    toolCallCount: 5,
    ...overrides,
  });

  it("rounds a duration to a single unit and rejects a missing or inverted span", () => {
    expect(formatDuration("2026-03-04T00:00:00Z", "2026-03-04T00:41:00Z")).toBe("41m");
    expect(formatDuration("2026-03-04T00:00:00Z", "2026-03-04T02:05:00Z")).toBe("2h 5m");
    expect(formatDuration("2026-03-04T00:00:00Z", "2026-03-06T00:00:00Z")).toBe("2d");
    expect(formatDuration(undefined, "2026-03-04T00:41:00Z")).toBeUndefined();
    expect(formatDuration("2026-03-04T00:41:00Z", "2026-03-04T00:00:00Z")).toBeUndefined();
  });

  it("falls back from duration to whatever dates are actually present — never a fake cue", () => {
    expect(sessionDurationOrDates(detail({ startedAt: "2026-03-04T00:00:00Z", endedAt: "2026-03-04T00:41:00Z" }))).toBe("41m");
    expect(sessionDurationOrDates(detail({ startedAt: "2026-03-04T00:00:00Z" }))).toMatch(/mar/);
    expect(sessionDurationOrDates(detail())).toBeUndefined();
  });

  it("builds the modal counts line with the duration/dates segment only when it exists", () => {
    expect(sessionDetailStats(detail({ startedAt: "2026-03-04T00:00:00Z", endedAt: "2026-03-04T00:41:00Z" }))).toBe("12 messages · 5 tool calls · 41m");
    expect(sessionDetailStats(detail())).toBe("12 messages · 5 tool calls");
  });
});

describe("cached fetchers", () => {
  const runtimeWindow = { vellum: undefined as unknown };
  (globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

  afterEach(() => {
    runtimeWindow.vellum = undefined;
    vi.restoreAllMocks();
  });

  it("reports tower unreachable without throwing when the bridge method is absent", async () => {
    runtimeWindow.vellum = {};
    const result = await fetchTowerBrowse("no-bridge-yet");
    expect(result).toEqual({ ok: false, error: "tower unreachable", glyphs: [], signals: [] });
  });

  it("caches a successful towerBrowse response per key within the TTL", async () => {
    const towerBrowse = vi.fn(async (): Promise<TowerBrowseResult> => ({ ok: true, glyphs: [], signals: [] }));
    runtimeWindow.vellum = { towerBrowse };
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await fetchTowerBrowse("proj-cache-a");
    await fetchTowerBrowse("proj-cache-a");
    expect(towerBrowse).toHaveBeenCalledTimes(1);

    nowSpy.mockReturnValue(1_000_000 + BROWSE_CACHE_TTL_MS + 1);
    await fetchTowerBrowse("proj-cache-a");
    expect(towerBrowse).toHaveBeenCalledTimes(2);
  });

  it("force-bypasses the towerBrowse cache so deliberate writes re-read live rows", async () => {
    const towerBrowse = vi.fn(async (): Promise<TowerBrowseResult> => ({ ok: true, glyphs: [], signals: [] }));
    runtimeWindow.vellum = { towerBrowse };
    vi.spyOn(Date, "now").mockReturnValue(1_500_000);

    await fetchTowerBrowse("proj-cache-force");
    await fetchTowerBrowse("proj-cache-force");
    expect(towerBrowse).toHaveBeenCalledTimes(1);

    await fetchTowerBrowse("proj-cache-force", { force: true });
    expect(towerBrowse).toHaveBeenCalledTimes(2);

    invalidateTowerBrowse("proj-cache-force");
    await fetchTowerBrowse("proj-cache-force");
    expect(towerBrowse).toHaveBeenCalledTimes(3);
  });

  it("keys the quasarSessions cache by both project key and limit", async () => {
    const quasarSessions = vi.fn(async (): Promise<QuasarSessionsResult> => ({ ok: true, sessions: [] }));
    runtimeWindow.vellum = { quasarSessions };
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);

    await fetchQuasarSessions("proj-cache-b", 30);
    await fetchQuasarSessions("proj-cache-b", 30);
    expect(quasarSessions).toHaveBeenCalledTimes(1);

    await fetchQuasarSessions("proj-cache-b", 10);
    expect(quasarSessions).toHaveBeenCalledTimes(2);
  });

  it("does not cache search results — every call reaches the bridge", async () => {
    const towerSearch = vi.fn(async () => ({ ok: true, matches: [] }));
    runtimeWindow.vellum = { towerSearch };

    await fetchTowerSearch("glyph", "proj-search");
    await fetchTowerSearch("glyph", "proj-search");
    expect(towerSearch).toHaveBeenCalledTimes(2);
  });

  it("turns a thrown/rejected bridge call into an unreachable result", async () => {
    runtimeWindow.vellum = { towerBrowse: async () => { throw new Error("ipc timeout"); } };
    const result = await fetchTowerBrowse("proj-cache-throws");
    expect(result.ok).toBe(false);
  });

  it("probes dispatches once per project and caches the result — same call gates the tab and supplies its rows", async () => {
    const towerDispatches = vi.fn(async (): Promise<TowerDispatchesResult> => ({ ok: true, dispatches: [] }));
    runtimeWindow.vellum = { towerDispatches };
    vi.spyOn(Date, "now").mockReturnValue(3_000_000);

    const first = await fetchTowerDispatches("proj-dispatches");
    const second = await fetchTowerDispatches("proj-dispatches");
    expect(towerDispatches).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("reports dispatches unreachable without throwing when the bridge method is absent", async () => {
    runtimeWindow.vellum = {};
    const result = await fetchTowerDispatches("no-bridge-yet");
    expect(result).toEqual({ ok: false, error: "tower unreachable", dispatches: [] });
  });

  it("caches glyph/signal reads by the full projectKey/orbit/id composite", async () => {
    const towerGlyphRead = vi.fn(async () => ({ ok: true, glyph: undefined }));
    const towerSignalRead = vi.fn(async () => ({ ok: true, signal: undefined }));
    runtimeWindow.vellum = { towerGlyphRead, towerSignalRead };
    vi.spyOn(Date, "now").mockReturnValue(4_000_000);

    await fetchTowerGlyphRead("proj", "forge", "g1");
    await fetchTowerGlyphRead("proj", "forge", "g1");
    await fetchTowerGlyphRead("proj", "forge", "g2");
    expect(towerGlyphRead).toHaveBeenCalledTimes(2);

    await fetchTowerSignalRead("proj", "forge", "sig1");
    await fetchTowerSignalRead("proj", "forge", "sig1");
    expect(towerSignalRead).toHaveBeenCalledTimes(1);
  });

  it("caches quasar session detail by sessionId and reports unreachable when the bridge is absent", async () => {
    const quasarSessionDetail = vi.fn(async () => ({ ok: true, detail: undefined }));
    runtimeWindow.vellum = { quasarSessionDetail };
    vi.spyOn(Date, "now").mockReturnValue(5_000_000);

    await fetchQuasarSessionDetail("s1");
    await fetchQuasarSessionDetail("s1");
    expect(quasarSessionDetail).toHaveBeenCalledTimes(1);

    runtimeWindow.vellum = {};
    const result = await fetchQuasarSessionDetail("s2");
    expect(result).toEqual({ ok: false, error: "quasar unreachable" });
  });
});
