import { describe, expect, it } from "vitest";
import { nextCronOccurrenceIn } from "../src/shared/cron-expression";

const at = (iso: string) => Date.parse(iso);

describe("nextCronOccurrenceIn", () => {
  it("fires on the named timezone's wall clock", () => {
    // 09:00 in Sao Paulo (UTC-3, no DST since 2019) is 12:00 UTC.
    expect(nextCronOccurrenceIn("0 9 * * *", at("2026-10-21T05:00:00Z"), "America/Sao_Paulo")).toBe(
      at("2026-10-21T12:00:00Z"),
    );
    expect(nextCronOccurrenceIn("0 9 * * *", at("2026-10-21T05:00:00Z"), "UTC")).toBe(at("2026-10-21T09:00:00Z"));
  });

  it("is strictly after the given instant", () => {
    expect(nextCronOccurrenceIn("0 9 * * *", at("2026-10-21T09:00:00Z"), "UTC")).toBe(at("2026-10-22T09:00:00Z"));
    expect(nextCronOccurrenceIn("*/15 * * * *", at("2026-10-21T09:14:59Z"), "UTC")).toBe(at("2026-10-21T09:15:00Z"));
  });

  it("matches weekdays on the local date, not the UTC date", () => {
    // Friday 2026-10-23 22:00 in Los Angeles is Saturday 05:00 UTC.
    expect(nextCronOccurrenceIn("0 22 * * 5", at("2026-10-23T12:00:00Z"), "America/Los_Angeles")).toBe(
      at("2026-10-24T05:00:00Z"),
    );
  });

  it("follows daylight saving time", () => {
    // New York: EDT (UTC-4) until 2026-11-01, then EST (UTC-5).
    expect(nextCronOccurrenceIn("0 9 * * *", at("2026-10-31T00:00:00Z"), "America/New_York")).toBe(
      at("2026-10-31T13:00:00Z"),
    );
    expect(nextCronOccurrenceIn("0 9 * * *", at("2026-11-01T00:00:00Z"), "America/New_York")).toBe(
      at("2026-11-01T14:00:00Z"),
    );
  });

  it("fires a spring-forward gap at the shifted instant", () => {
    // 02:30 does not exist in New York on 2027-03-14; it fires at 03:30 EDT.
    expect(nextCronOccurrenceIn("30 2 * * *", at("2027-03-14T00:00:00Z"), "America/New_York")).toBe(
      at("2027-03-14T07:30:00Z"),
    );
  });

  it("fires a fall-back hour once", () => {
    // 01:30 New York happens twice on 2026-11-01; the first is 05:30 UTC.
    const first = nextCronOccurrenceIn("30 1 * * *", at("2026-11-01T00:00:00Z"), "America/New_York");
    expect(first).toBe(at("2026-11-01T05:30:00Z"));
    expect(nextCronOccurrenceIn("30 1 * * *", first!, "America/New_York")).toBe(at("2026-11-02T06:30:00Z"));
  });

  it("refuses an invalid expression", () => {
    expect(nextCronOccurrenceIn("nope", 0, "UTC")).toBeUndefined();
  });
});
