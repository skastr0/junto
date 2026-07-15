import { describe, expect, it } from "vitest";
import type { TowerBrowseResult, TowerGlyphRow } from "../src/shared/ipc";
import { resolveGlyphCacheUpdate } from "../src/main/vellum/kernel/service";

// forge-review sdk-kernel-build fix 2 (kernel-side half) — a partial
// tower-browse read must never be authoritative for edge decisions.

describe("resolveGlyphCacheUpdate", () => {
  const glyphRow = (glyphId: string, state: string): TowerGlyphRow => ({
    glyphId,
    orbit: "forge",
    title: "t",
    state,
    updatedAt: 1,
  });

  const complete = (glyphs: ReadonlyArray<TowerGlyphRow>): TowerBrowseResult => ({
    ok: true,
    glyphs,
    signals: [],
  });

  const partial = (glyphs: ReadonlyArray<TowerGlyphRow>): TowerBrowseResult => ({
    ok: true,
    glyphs,
    signals: [],
    partial: true,
  });

  const failed = (): TowerBrowseResult => ({ ok: false, error: "gateway unreachable", glyphs: [], signals: [] });

  it("a complete read is written to cache and returned as-is", () => {
    const fresh = complete([glyphRow("g1", "done")]);
    const result = resolveGlyphCacheUpdate(fresh, undefined);
    expect(result.rows).toEqual(fresh.glyphs);
    expect(result.cacheWrite).toEqual(fresh.glyphs);
  });

  it("a complete read overwrites a prior complete cache entry", () => {
    const cached = { rows: [glyphRow("g1", "building")] };
    const fresh = complete([glyphRow("g1", "done")]);
    const result = resolveGlyphCacheUpdate(fresh, cached);
    expect(result.rows).toEqual(fresh.glyphs);
    expect(result.cacheWrite).toEqual(fresh.glyphs);
  });

  it("a partial read with a prior complete cache prefers the cached-complete rows and does not write cache", () => {
    const cached = { rows: [glyphRow("g1", "done"), glyphRow("g2", "done")] };
    // The fresh partial read under-reports — only g1 landed this pass.
    const fresh = partial([glyphRow("g1", "done")]);
    const result = resolveGlyphCacheUpdate(fresh, cached);
    expect(result.rows).toEqual(cached.rows);
    expect(result.cacheWrite).toBeUndefined();
  });

  it("a partial read with NO prior cache falls through to unknown (undefined), never the partial rows", () => {
    const fresh = partial([glyphRow("g1", "done")]);
    const result = resolveGlyphCacheUpdate(fresh, undefined);
    expect(result.rows).toBeUndefined();
    expect(result.cacheWrite).toBeUndefined();
  });

  it("a failed (ok:false) read falls back to whatever is cached, complete or not", () => {
    const cached = { rows: [glyphRow("g1", "done")] };
    const result = resolveGlyphCacheUpdate(failed(), cached);
    expect(result.rows).toEqual(cached.rows);
    expect(result.cacheWrite).toBeUndefined();
  });

  it("a failed read with no cache returns undefined", () => {
    const result = resolveGlyphCacheUpdate(failed(), undefined);
    expect(result.rows).toBeUndefined();
    expect(result.cacheWrite).toBeUndefined();
  });
});
