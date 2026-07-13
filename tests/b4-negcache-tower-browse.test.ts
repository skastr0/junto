import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileSyncMock = vi.fn();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => readFileSyncMock(...args),
  };
});

// tower-browse.ts holds `cachedConfig` at module scope, so every test needs
// a fresh module instance — otherwise a config cached (or invalidated) by
// one test leaks into the next.
const loadAdapter = async () => {
  vi.resetModules();
  return import("../src/main/vellum/adapters/tower-browse");
};

const configJson = (token: string) => JSON.stringify({ url: "https://gateway.test/tower-api", token });

// The gateway is fanned out across 5 orbits x (glyphs, signals) = 10 calls.
const ORBIT_COUNT = 5;
const REQUESTS_PER_FANOUT = ORBIT_COUNT * 2;

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

beforeEach(() => {
  readFileSyncMock.mockReset();
  vi.unstubAllGlobals();
});

describe("fetchTowerBrowse — total-outage negative-cache regression", () => {
  it("returns ok:false when every one of the 10 fanned-out requests fails (total gateway outage)", async () => {
    readFileSyncMock.mockReturnValue(configJson("tok-a"));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: "gateway down" }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTowerBrowse } = await loadAdapter();
    const result = await fetchTowerBrowse("vellum");

    expect(result.ok).toBe(false);
    expect(result.glyphs).toEqual([]);
    expect(result.signals).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(REQUESTS_PER_FANOUT);
  });

  it("stays ok:true when only some of the 10 requests fail (partial outage)", async () => {
    readFileSyncMock.mockReturnValue(configJson("tok-a"));
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("orbit=forge") && url.includes("/api/glyphs")) {
        return jsonResponse(200, {
          items: [{ glyphId: "g1", orbit: "forge", title: "t", state: "building", updatedAt: 1 }],
        });
      }
      return jsonResponse(500, { error: "down" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTowerBrowse } = await loadAdapter();
    const result = await fetchTowerBrowse("vellum");

    expect(result.ok).toBe(true);
    expect(result.glyphs).toEqual([{ glyphId: "g1", orbit: "forge", title: "t", state: "building", updatedAt: 1 }]);
    expect(result.signals).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(REQUESTS_PER_FANOUT);
  });

  it("never throws and reports total failure distinctly from a legitimate empty project", async () => {
    readFileSyncMock.mockReturnValue(configJson("tok-a"));
    // Legitimate-empty case for comparison: every request succeeds with an
    // empty payload.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { items: [], signals: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTowerBrowse } = await loadAdapter();
    const emptyButHealthy = await fetchTowerBrowse("vellum");

    expect(emptyButHealthy).toEqual({ ok: true, glyphs: [], signals: [] });
  });
});

describe("fetchTowerBrowse — stale-token (401) recovery", () => {
  it("on all-401, invalidates the cached config and re-reads it exactly once, retrying with the fresh token", async () => {
    readFileSyncMock.mockReturnValueOnce(configJson("stale-token")).mockReturnValueOnce(configJson("fresh-token"));

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      if (auth === "Bearer stale-token") return jsonResponse(401, { error: "unauthorized" });
      if (auth === "Bearer fresh-token") return jsonResponse(200, { items: [], signals: [] });
      throw new Error(`unexpected auth header: ${auth}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTowerBrowse } = await loadAdapter();
    const result = await fetchTowerBrowse("vellum");

    expect(result).toEqual({ ok: true, glyphs: [], signals: [] });
    // Initial load + exactly one re-read after the 401-triggered invalidation.
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
    // 10 requests against the stale token, then 10 more against the fresh one.
    expect(fetchMock).toHaveBeenCalledTimes(REQUESTS_PER_FANOUT * 2);
  });

  it("gives up with ok:false (not an infinite retry loop) when the re-read config is still unauthorized", async () => {
    readFileSyncMock.mockReturnValueOnce(configJson("stale-token")).mockReturnValueOnce(configJson("still-stale"));

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTowerBrowse } = await loadAdapter();
    const result = await fetchTowerBrowse("vellum");

    expect(result.ok).toBe(false);
    expect(result.glyphs).toEqual([]);
    expect(result.signals).toEqual([]);
    // Config was re-read exactly once to attempt recovery, not retried again.
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(REQUESTS_PER_FANOUT * 2);
  });

  it("does not touch the cached config on a non-401 failure", async () => {
    readFileSyncMock.mockReturnValue(configJson("tok-a"));
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, { error: "server error" }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchTowerBrowse } = await loadAdapter();
    const result = await fetchTowerBrowse("vellum");

    expect(result.ok).toBe(false);
    // No 401 anywhere -> no reason to invalidate/re-read the config; single
    // fan-out only.
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(REQUESTS_PER_FANOUT);
  });
});
