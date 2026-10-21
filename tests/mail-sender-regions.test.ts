/**
 * A mail's sender stamp has a bounded size: it names at most
 * MAIL_SENDER_REGIONS_MAX regions, the innermost ones, and every region name
 * is at most REGION_NAME_MAX characters.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MAIL_SENDER_REGIONS_MAX, readMailExtension } from "../src/shared/crew";
import { REGION_NAME_MAX, Region, mailSenderRegions, seatRegions } from "../src/shared/model";
import { canvasOf, region, seat } from "./support/model-nodes";

const DEPTH = MAIL_SENDER_REGIONS_MAX + 4;

/** DEPTH regions nested inside each other, outermost first, and a seat in the middle of them all. */
const nested = canvasOf([
  ...Array.from({ length: DEPTH }, (_, index) =>
    region(`r${index}`, { x: index * 10, y: index * 10, width: 2000 - index * 20, height: 2000 - index * 20 }, {
      label: `level ${index}`,
    })),
  seat("deep", { x: 990, y: 990, width: 10, height: 10, label: "deep" }),
]);

const extension = (regions: ReadonlyArray<{ readonly id: string; readonly name: string }>) => ({
  mailKind: "notice",
  fromSeat: `seat_${"1".repeat(64)}`,
  senderRegions: regions,
  senderGeneration: "g",
  senderHarness: "claude",
});

describe("mail sender regions", () => {
  it("keeps the innermost regions, still outermost first", () => {
    const all = seatRegions(nested, "deep");
    expect(all).toHaveLength(DEPTH);
    const stamped = mailSenderRegions(nested, "deep");
    expect(stamped).toHaveLength(MAIL_SENDER_REGIONS_MAX);
    expect(stamped).toEqual(all.slice(DEPTH - MAIL_SENDER_REGIONS_MAX));
    expect(stamped.at(-1)).toEqual({ id: `r${DEPTH - 1}`, name: `level ${DEPTH - 1}` });
  });

  it("names every region when there are no more than the bound", () => {
    const shallow = canvasOf([
      region("outer", { x: 0, y: 0, width: 1000, height: 1000 }, { label: "Junto" }),
      seat("lead", { x: 20, y: 20, width: 10, height: 10, label: "lead" }),
    ]);
    expect(mailSenderRegions(shallow, "lead")).toEqual([{ id: "outer", name: "Junto" }]);
  });

  it("refuses a region name longer than the bound", () => {
    const decode = Schema.decodeUnknownExit(Region);
    const named = (label: string) => ({
      kind: "region", id: "r", x: 0, y: 0, width: 10, height: 10, z: 0, hold: false, label,
    });
    expect(decode(named("a".repeat(REGION_NAME_MAX)))._tag).toBe("Success");
    expect(decode(named("a".repeat(REGION_NAME_MAX + 1)))._tag).toBe("Failure");
  });

  it("reads no stamp with too many regions or too long a name", () => {
    const at = (count: number, name = "n") => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, name }));
    expect(readMailExtension(extension(at(MAIL_SENDER_REGIONS_MAX)))).toBeDefined();
    expect(readMailExtension(extension(at(MAIL_SENDER_REGIONS_MAX + 1)))).toBeUndefined();
    expect(readMailExtension(extension(at(1, "a".repeat(REGION_NAME_MAX + 1))))).toBeUndefined();
  });
});
