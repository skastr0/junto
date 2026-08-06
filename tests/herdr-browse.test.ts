import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrSessionInfo, HerdrWorkspaceInfo } from "../src/shared/ipc";
import {
  HERDR_BROWSE_TTL_MS,
  fetchHerdrSessions,
  fetchHerdrWorkspaces,
  herdrBrowseCacheGet,
  herdrBrowseCacheInvalidateHost,
  herdrBrowseCacheSet,
  herdrBrowseKey,
  invalidateHerdrBrowse,
  peekHerdrBrowse,
  type HerdrBrowseCacheEntry,
} from "../src/renderer/lib/herdr-browse";

// Wait one macrotask so background revalidate microtasks flush.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("herdr-browse pure cache core", () => {
  it("keys by step + host + session + parent, distinguishing default from named sessions", () => {
    const a = herdrBrowseKey({ step: "workspaces", hostId: "h1", session: null });
    const b = herdrBrowseKey({ step: "workspaces", hostId: "h1", session: "named" });
    const c = herdrBrowseKey({ step: "tabs", hostId: "h1", session: null, parentId: "w1" });
    const d = herdrBrowseKey({ step: "tabs", hostId: "h1", session: null, parentId: "w1:t1" });
    expect(new Set([a, b, c, d]).size).toBe(4);
    // Same inputs → same key (stable).
    expect(herdrBrowseKey({ step: "tabs", hostId: "h1", session: null, parentId: "w1" })).toBe(c);
  });

  it("returns a live entry and expires it past the TTL", () => {
    const cache = new Map<string, HerdrBrowseCacheEntry>();
    herdrBrowseCacheSet(cache, "k", "h1", [1, 2, 3], 1_000);
    expect(herdrBrowseCacheGet(cache, "k", 1_000)?.rows).toEqual([1, 2, 3]);
    expect(herdrBrowseCacheGet(cache, "k", 1_000 + HERDR_BROWSE_TTL_MS)?.rows).toEqual([1, 2, 3]);
    expect(herdrBrowseCacheGet(cache, "k", 1_000 + HERDR_BROWSE_TTL_MS + 1)).toBeUndefined();
    expect(herdrBrowseCacheGet(cache, "missing", 1_000)).toBeUndefined();
  });

  it("invalidates only the entries of a given host", () => {
    const cache = new Map<string, HerdrBrowseCacheEntry>();
    herdrBrowseCacheSet(cache, "h1-sessions", "h1", [], 0);
    herdrBrowseCacheSet(cache, "h1-tabs", "h1", [], 0);
    herdrBrowseCacheSet(cache, "h2-sessions", "h2", [], 0);
    herdrBrowseCacheInvalidateHost(cache, "h1");
    expect(cache.has("h1-sessions")).toBe(false);
    expect(cache.has("h1-tabs")).toBe(false);
    expect(cache.has("h2-sessions")).toBe(true);
  });
});

describe("herdr-browse fetchers (stale-while-revalidate)", () => {
  const runtimeWindow = { vellumCommand: undefined as unknown };
  (globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

  afterEach(() => {
    runtimeWindow.vellumCommand = undefined;
    invalidateHerdrBrowse();
    vi.restoreAllMocks();
  });

  const sess = (name: string): HerdrSessionInfo => ({ name });

  it("misses cold, returns fromCache:false, and caches the rows", async () => {
    const herdrListSessions = vi.fn(async () => ({ ok: true, data: [sess("a")] }));
    runtimeWindow.vellumCommand = { herdrListSessions };
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    const first = await fetchHerdrSessions("h1");
    expect(first.fromCache).toBe(false);
    expect(first.rows).toEqual([sess("a")]);
    expect(herdrListSessions).toHaveBeenCalledTimes(1);
    // Synchronous peek now sees the cached rows.
    expect(peekHerdrBrowse<HerdrSessionInfo>({ step: "sessions", hostId: "h1", session: null })).toEqual([sess("a")]);
  });

  it("serves stale rows first on a hit, then delivers fresh rows via onUpdate", async () => {
    let call = 0;
    const herdrListSessions = vi.fn(async () => ({ ok: true, data: call++ === 0 ? [sess("a")] : [sess("a"), sess("b")] }));
    runtimeWindow.vellumCommand = { herdrListSessions };
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);

    await fetchHerdrSessions("h1");
    expect(herdrListSessions).toHaveBeenCalledTimes(1);

    const updates: ReadonlyArray<HerdrSessionInfo>[] = [];
    const second = await fetchHerdrSessions("h1", { onUpdate: (rows) => updates.push(rows) });
    // Stale rows returned immediately; onUpdate has NOT fired yet at return time.
    expect(second.fromCache).toBe(true);
    expect(second.rows).toEqual([sess("a")]);
    expect(updates).toEqual([]);

    await flush();
    expect(herdrListSessions).toHaveBeenCalledTimes(2);
    expect(updates).toEqual([[sess("a"), sess("b")]]);
  });

  it("force bypasses the cache and refetches in the foreground", async () => {
    const herdrListWorkspaces = vi.fn(async (): Promise<{ ok: boolean; data?: ReadonlyArray<HerdrWorkspaceInfo> }> => ({
      ok: true,
      data: [],
    }));
    runtimeWindow.vellumCommand = { herdrListWorkspaces };
    vi.spyOn(Date, "now").mockReturnValue(3_000_000);

    // Cold miss is a lone foreground fetch (no background revalidate on a miss).
    const cold = await fetchHerdrWorkspaces("h1", null);
    expect(cold.fromCache).toBe(false);
    expect(herdrListWorkspaces).toHaveBeenCalledTimes(1);

    // Force skips the fresh cache entry entirely and refetches in the foreground.
    const forced = await fetchHerdrWorkspaces("h1", null, { force: true });
    expect(forced.fromCache).toBe(false);
    expect(herdrListWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("invalidateHerdrBrowse(host) forces the next fetch to reach the bridge", async () => {
    const herdrListSessions = vi.fn(async () => ({ ok: true, data: [sess("a")] }));
    runtimeWindow.vellumCommand = { herdrListSessions };
    vi.spyOn(Date, "now").mockReturnValue(4_000_000);

    await fetchHerdrSessions("h1");
    expect(herdrListSessions).toHaveBeenCalledTimes(1);

    invalidateHerdrBrowse("h1");
    expect(peekHerdrBrowse({ step: "sessions", hostId: "h1", session: null })).toBeUndefined();
    const after = await fetchHerdrSessions("h1");
    expect(after.fromCache).toBe(false);
    expect(herdrListSessions).toHaveBeenCalledTimes(2);
  });

  it("rejects when a list call reports failure, keeping stale rows for a background failure", async () => {
    let ok = true;
    const herdrListSessions = vi.fn(async () => (ok ? { ok: true, data: [sess("a")] } : { ok: false, message: "boom" }));
    runtimeWindow.vellumCommand = { herdrListSessions };
    vi.spyOn(Date, "now").mockReturnValue(5_000_000);

    await fetchHerdrSessions("h1");
    ok = false;
    // Cache hit → stale returned, background refresh fails and is swallowed.
    const hit = await fetchHerdrSessions("h1", { onUpdate: () => undefined });
    expect(hit.rows).toEqual([sess("a")]);
    await flush();
    // Stale rows survive a failed background revalidate.
    expect(peekHerdrBrowse<HerdrSessionInfo>({ step: "sessions", hostId: "h1", session: null })).toEqual([sess("a")]);

    invalidateHerdrBrowse("h1");
    await expect(fetchHerdrSessions("h1")).rejects.toThrow("boom");
  });

  it("throws when the herdr bridge is absent", async () => {
    runtimeWindow.vellumCommand = undefined;
    await expect(fetchHerdrSessions("h1")).rejects.toThrow(/unavailable/);
  });
});
