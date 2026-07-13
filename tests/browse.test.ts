import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  QuasarSessionDetail,
  QuasarSessionsResult,
  TowerBrowseResult,
  TowerDispatchesResult,
  TowerGlyphRow,
} from "../src/shared/ipc";
import {
  BROWSE_CACHE_TTL_MS,
  fetchQuasarSessionDetail,
  fetchQuasarSessions,
  fetchTowerBrowse,
  fetchTowerDispatches,
  fetchTowerGlyphRead,
  fetchTowerSearch,
  fetchTowerSignalRead,
  formatCollapsedSummary,
  formatDuration,
  glyphStateHue,
  groupGlyphs,
  sessionDetailStats,
  sessionDurationOrDates,
  sessionStats,
  sessionTitle,
  shortDate,
  shortKind,
  signalStatusHue,
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
