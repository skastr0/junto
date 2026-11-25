import { describe, expect, it } from "vitest";
import { connectionCount, groupConnections, matchConnections, OPEN_FIELD, seatConnections } from "../src/window/lib/seat-connections";
import * as fixtures from "./support/model-nodes";

// lead sits in "Product"; cli and pty sit in "CLI" inside "Junto"; board sits in the open field.
const canvas = fixtures.canvasOf(
  [
    fixtures.region("junto", { x: 0, y: 0, width: 2000, height: 1000 }, { label: "Junto" }),
    fixtures.region("cli-region", { x: 1000, y: 0, width: 900, height: 400 }, { label: "CLI", color: "cyan" }),
    fixtures.region("product", { x: 0, y: 2000, width: 900, height: 400 }, { label: "Product" }),
    fixtures.seat("lead", { label: "product-lead", x: 10, y: 2010 }),
    fixtures.seat("design", { label: "product-design", x: 300, y: 2010 }),
    fixtures.seat("cli", { label: "cli-lead", x: 1010, y: 10 }),
    fixtures.seat("pty", { label: "pty-lead", x: 1300, y: 10 }),
    fixtures.taskBoard("board", { x: 5000, y: 5000 }),
    fixtures.seat("far", { label: "far", x: 6000, y: 6000 }),
  ],
  [
    fixtures.wire("w-cli", "lead", "cli", "messages"),
    fixtures.wire("w-pty-in", "pty", "lead", "messages"),
    fixtures.wire("w-design-out", "lead", "design", "messages"),
    fixtures.wire("w-design-in", "design", "lead", "messages"),
    fixtures.wire("w-board", "board", "lead", "flows"),
    fixtures.wire("w-other", "cli", "pty", "messages"),
  ],
);

describe("seatConnections", () => {
  it("lists every wire that touches the seat, one row each, by the other end's name", () => {
    const rows = seatConnections(canvas, "lead");
    const names = rows.map((row) => row.otherName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })));
    expect(rows).toHaveLength(5);
    expect(rows.some((row) => row.wireId === "w-other")).toBe(false);
  });

  it("says each wire as a sentence in its stored order, and which way it goes", () => {
    const byId = new Map(seatConnections(canvas, "lead").map((row) => [row.wireId, row]));
    expect(byId.get("w-cli")).toMatchObject({ sentence: "product-lead messages cli-lead", way: "out", path: "Junto / CLI" });
    expect(byId.get("w-pty-in")).toMatchObject({ sentence: "pty-lead messages product-lead", way: "in" });
    // Wired both ways: each wire is its own row, and says only its own way.
    expect(byId.get("w-design-out")).toMatchObject({ sentence: "product-lead messages product-design", way: "out" });
    expect(byId.get("w-design-in")).toMatchObject({ sentence: "product-design messages product-lead", way: "in" });
    expect(byId.get("w-board")?.sentence).toContain("flows into product-lead");
    expect(byId.get("w-board")?.path).toBe("");
  });

  it("counts what the list shows, for the bar key", () => {
    for (const id of ["lead", "cli", "pty", "design", "board", "far", "missing"]) {
      expect(connectionCount(canvas, id), id).toBe(seatConnections(canvas, id).length);
    }
  });

  it("counts what it lists for a self-wire and a wire whose other end is gone", () => {
    const odd = fixtures.canvasOf(
      [fixtures.seat("lead", { label: "product-lead" }), fixtures.seat("solo", { label: "solo" })],
      [
        fixtures.wire("w-self", "lead", "lead", "messages"),
        fixtures.wire("w-ghost", "lead", "gone", "messages"),
        fixtures.wire("w-ok", "lead", "solo", "messages"),
      ],
    );
    expect(seatConnections(odd, "lead").map((row) => row.wireId)).toEqual(["w-ok"]);
    expect(connectionCount(odd, "lead")).toBe(seatConnections(odd, "lead").length);
  });

  it("lists nothing for a seat with no wire or a seat that is gone", () => {
    expect(seatConnections(canvas, "far")).toEqual([]);
    expect(seatConnections(canvas, "missing")).toEqual([]);
  });
});

describe("matchConnections", () => {
  it("matches the other end's name or region path, ignoring case", () => {
    const rows = seatConnections(canvas, "lead");
    expect(matchConnections(rows, "PTY").map((row) => row.wireId)).toEqual(["w-pty-in"]);
    expect(matchConnections(rows, "cli").map((row) => row.wireId).sort()).toEqual(["w-cli", "w-pty-in"]);
    expect(matchConnections(rows, "junto /").map((row) => row.wireId).sort()).toEqual(["w-cli", "w-pty-in"]);
    expect(matchConnections(rows, "  ")).toBe(rows);
    expect(matchConnections(rows, "nobody")).toEqual([]);
  });
});

describe("groupConnections", () => {
  it("groups by the other end's innermost region: the seat's own first, the open field last", () => {
    const groups = groupConnections(canvas, "lead", seatConnections(canvas, "lead"));
    expect(groups.map((group) => group.name)).toEqual(["Product", "CLI", OPEN_FIELD]);
    expect(groups[1]).toMatchObject({ regionId: "cli-region", outer: ["Junto"], color: "cyan" });
    expect(groups[1]!.rows.map((row) => row.otherName)).toEqual(["cli-lead", "pty-lead"]);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[2]!.regionId).toBeNull();
  });

  it("makes no group for rows a search left out", () => {
    const rows = matchConnections(seatConnections(canvas, "lead"), "pty");
    expect(groupConnections(canvas, "lead", rows).map((group) => group.name)).toEqual(["CLI"]);
  });
});
