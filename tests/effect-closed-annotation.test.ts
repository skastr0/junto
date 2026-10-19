/**
 * Upgrade tripwire. About fifty schemas (the agent protocol in
 * work-control.ts, agent signals, seat control, machine logs, node inserts,
 * content staging, CLI inputs) are closed only by an annotation,
 * `parseOptions: { onExcessProperty: "error" }`, and many are decoded nested
 * inside another struct. Effect rc.112, which this repository pins, honours
 * that annotation on a nested struct; rc.117 does not, so an upgrade would
 * open every one of them silently (found by app-feed in junto-app).
 *
 * The doctrine (docs/security-doctrine.md, 29cca7f1d) is that a closed decode
 * passes the option itself. Until every site does, this test fails the
 * moment Effect stops honouring the nested annotation: fix those decode
 * sites before the upgrade lands, then delete this test.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";

describe("the Effect build this repository pins", () => {
  it("still refuses an extra key in a nested struct closed only by its annotation", () => {
    const Inner = Schema.Struct({ a: Schema.String }).annotate({ parseOptions: { onExcessProperty: "error" } });
    const Outer = Schema.Struct({ args: Inner });
    const decoded = Schema.decodeUnknownResult(Outer)({ args: { a: "x", path: "/etc/passwd" } });
    expect(
      Result.isFailure(decoded),
      "Effect no longer honours a nested parseOptions annotation: pass onExcessProperty explicitly at every annotation-only decode site before upgrading",
    ).toBe(true);
  });

  it("still refuses an extra key at the top level closed only by its annotation", () => {
    const Closed = Schema.Struct({ a: Schema.String }).annotate({ parseOptions: { onExcessProperty: "error" } });
    expect(Result.isFailure(Schema.decodeUnknownResult(Closed)({ a: "x", path: "/etc/passwd" }))).toBe(true);
  });
});
