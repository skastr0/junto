/**
 * Roll call rendering for the ready/complete tier.
 *
 * The command card is where an operator reads a region at a glance, so the
 * finished-but-unread bucket has to reach the markup with its own green mark,
 * its count, and the seat's name — not fold into "All quiet".
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MemberStatus, RegionRollup } from "../src/shared/region-rollup";
import { RollCall } from "../src/renderer/components/rts/RollCall";
import { GREEN } from "../src/renderer/lib/theme";

const member = (
  nodeId: string,
  severity: MemberStatus["severity"],
  reasons: ReadonlyArray<string> = [],
): MemberStatus => ({ nodeId, label: nodeId, kind: "agent", severity, reasons });

const rollup = (members: ReadonlyArray<MemberStatus>): RegionRollup => ({
  regionId: "r",
  label: "ops",
  severity: members[0]?.severity ?? "idle",
  counts: {
    total: members.length,
    blocked: members.filter((m) => m.severity === "blocked").length,
    attention: members.filter((m) => m.severity === "attention").length,
    working: members.filter((m) => m.severity === "working").length,
    ready: members.filter((m) => m.severity === "ready").length,
  },
  members,
});

describe("RollCall ready tier", () => {
  it("renders finished seats as a green ready bucket with their names", () => {
    const html = renderToStaticMarkup(
      <RollCall
        rollup={rollup([
          member("profile-13", "ready", ["activity:ready"]),
          member("nix", "ready", ["activity:ready"]),
          member("quiet-one", "idle"),
        ])}
      />,
    );
    expect(html).toContain('data-severity="ready"');
    expect(html).toContain("2 ready");
    expect(html).toContain("profile-13, nix");
    expect(html).toContain(GREEN);
    expect(html).not.toContain("All quiet");
  });

  it("keeps working above ready and still shows both", () => {
    const html = renderToStaticMarkup(
      <RollCall
        rollup={rollup([
          member("busy", "working", ["activity:working"]),
          member("profile-13", "ready", ["activity:ready"]),
        ])}
      />,
    );
    expect(html.indexOf('data-severity="working"')).toBeLessThan(
      html.indexOf('data-severity="ready"'),
    );
    expect(html).toContain("1 working");
    expect(html).toContain("1 ready");
  });

  it("a region nobody has to read stays quiet", () => {
    const html = renderToStaticMarkup(<RollCall rollup={rollup([member("profile-13", "idle")])} />);
    expect(html).toContain("All quiet");
    expect(html).not.toContain('data-severity="ready"');
  });
});
