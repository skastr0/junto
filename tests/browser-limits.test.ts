import { describe, expect, it } from "vitest";
import {
  BROWSER_MAX_ABS_COORDINATE,
  BROWSER_MAX_ERROR_BYTES,
  BROWSER_MAX_SESSION_ID_BYTES,
  BROWSER_MAX_SURFACE_HEIGHT,
  BROWSER_MAX_SURFACE_PIXELS,
  BROWSER_MAX_SURFACE_WIDTH,
  clampUtf8Bytes,
  isUtf8WithinLimit,
  isValidBrowserSessionId,
  parseBrowserSessionId,
  parseBrowserSurfaceBounds,
  utf8ByteLength,
} from "../src/shared/browser-limits";

describe("browser shared hard limits", () => {
  it("counts UTF-8 bytes and clamps without splitting a code point", () => {
    expect(utf8ByteLength("a☃😀")).toBe(8);
    expect(clampUtf8Bytes("a☃😀", 7)).toBe("a☃");
    expect(clampUtf8Bytes("😀x", 3)).toBe("");
    expect(isUtf8WithinLimit("😀", 4)).toBe(true);
    expect(isUtf8WithinLimit("😀", 3)).toBe(false);
    expect(utf8ByteLength(clampUtf8Bytes("x".repeat(BROWSER_MAX_ERROR_BYTES + 1), BROWSER_MAX_ERROR_BYTES)))
      .toBe(BROWSER_MAX_ERROR_BYTES);
  });

  it("accepts only nonempty bounded ASCII session handles", () => {
    for (const value of ["session-1", "7d542b67-6ff8-45db-a475-6bcdb00dc47b", "agent:job.1"]) {
      expect(isValidBrowserSessionId(value)).toBe(true);
      expect(parseBrowserSessionId(value)).toEqual({ ok: true, value });
    }
    for (const value of [
      "",
      "-leading",
      "has space",
      "line\nbreak",
      "😀",
      "x".repeat(BROWSER_MAX_SESSION_ID_BYTES + 1),
      null,
      42,
    ]) {
      expect(parseBrowserSessionId(value).ok).toBe(false);
    }
  });

  it("parses only exact finite integer surface bounds inside every cap", () => {
    expect(parseBrowserSurfaceBounds({ x: -10, y: 20, width: 800, height: 600 })).toEqual({
      ok: true,
      value: { x: -10, y: 20, width: 800, height: 600 },
    });

    for (const value of [
      null,
      [],
      { x: 0, y: 0, width: 1, height: 1, extra: true },
      { x: 0.5, y: 0, width: 1, height: 1 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: BROWSER_MAX_ABS_COORDINATE + 1, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: BROWSER_MAX_SURFACE_WIDTH + 1, height: 1 },
      { x: 0, y: 0, width: 1, height: BROWSER_MAX_SURFACE_HEIGHT + 1 },
      { x: 0, y: 0, width: BROWSER_MAX_SURFACE_WIDTH, height: BROWSER_MAX_SURFACE_HEIGHT },
    ]) {
      expect(parseBrowserSurfaceBounds(value).ok).toBe(false);
    }
  });

  it("accepts a surface exactly at the pixel cap", () => {
    const width = Math.min(BROWSER_MAX_SURFACE_WIDTH, BROWSER_MAX_SURFACE_PIXELS);
    const height = Math.floor(BROWSER_MAX_SURFACE_PIXELS / width);
    expect(parseBrowserSurfaceBounds({ x: 0, y: 0, width, height })).toEqual({
      ok: true,
      value: { x: 0, y: 0, width, height },
    });
  });
});
