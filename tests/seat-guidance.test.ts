import { describe, expect, it } from "vitest";
import {
  SEAT_INSTRUCTIONS_MAX,
  SEAT_SOUL_MAX,
  normalizeSeatGuidance,
} from "../src/shared/seat-guidance";
import { makeSeatGuidanceIndex } from "../src/main/junto/seat-guidance/index-memory";

describe("normalizeSeatGuidance", () => {
  it("keeps the two fields cleaned: CRLF to LF, no NUL, trimmed", () => {
    expect(normalizeSeatGuidance({ soul: "  Calm.\r\nKind.\u0000 ", instructions: "Test first.", other: 1 })).toEqual({
      ok: true,
      guidance: { soul: "Calm.\nKind.", instructions: "Test first." },
    });
  });

  it("treats nothing left as a clear, never a row", () => {
    expect(normalizeSeatGuidance({ soul: "   ", instructions: "" })).toEqual({ ok: true, guidance: null });
    expect(normalizeSeatGuidance(null)).toEqual({ ok: true, guidance: null });
  });

  it("refuses text past its bound with a reason instead of cutting it", () => {
    expect(normalizeSeatGuidance({ soul: "s".repeat(SEAT_SOUL_MAX) }).ok).toBe(true);
    const soul = normalizeSeatGuidance({ soul: "s".repeat(SEAT_SOUL_MAX + 1) });
    expect(soul).toMatchObject({ ok: false, message: expect.stringContaining(String(SEAT_SOUL_MAX)) });
    const instructions = normalizeSeatGuidance({ instructions: "i".repeat(SEAT_INSTRUCTIONS_MAX + 1) });
    expect(instructions.ok).toBe(false);
  });

  it("refuses a non-object", () => {
    expect(normalizeSeatGuidance("soul").ok).toBe(false);
    expect(normalizeSeatGuidance([]).ok).toBe(false);
  });
});

describe("seat guidance index", () => {
  it("serves noted writes and never lets boot hydration undo one", () => {
    const index = makeSeatGuidanceIndex();
    index.note("a", { soul: "new" });
    index.note("b", null);
    index.hydrate({ a: { soul: "stale" }, b: { soul: "stale" }, c: { instructions: "loaded" } });
    expect(index.get("a")).toEqual({ soul: "new" });
    expect(index.get("b")).toBeUndefined();
    expect(index.get("c")).toEqual({ instructions: "loaded" });
  });
});
