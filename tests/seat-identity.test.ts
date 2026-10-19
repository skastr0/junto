import { describe, expect, it } from "vitest";
import { findSeatByName, regionPathText, seatIdentity, seatLabel, seatRegions } from "../src/shared/model";
import { canvasOf, region, seat } from "./support/model-nodes";

const at = (x: number, y: number) => ({ x, y, width: 100, height: 40 });

const canvas = canvasOf([
  region("outer", { x: 0, y: 0, width: 1000, height: 1000 }, { label: "Junto" }),
  region("inner", { x: 10, y: 10, width: 400, height: 400 }, { label: "CLI" }),
  region("blank", { x: 600, y: 600, width: 300, height: 300 }),
  seat("lead", { ...at(20, 20), label: "cli-lead" }),
  seat("twin-a", { ...at(20, 200), label: "Helper" }),
  seat("twin-b", { ...at(700, 700), label: "helper" }),
  seat("loose", { ...at(2000, 2000), label: "loose" }),
]);
const node = (id: string) => canvas.nodes.get(id as never)!;

describe("seat identity", () => {
  it("names every region around a seat, outermost first", () => {
    expect(seatRegions(canvas, "lead")).toEqual([{ id: "outer", name: "Junto" }, { id: "inner", name: "CLI" }]);
    expect(seatIdentity(canvas, node("twin-b"))).toEqual({
      nodeId: "twin-b",
      name: "helper",
      regions: [{ id: "outer", name: "Junto" }, { id: "blank", name: "unnamed region" }],
    });
    expect(seatRegions(canvas, "loose")).toEqual([]);
  });

  it("reads as one line", () => {
    expect(seatLabel(seatIdentity(canvas, node("lead")))).toBe("cli-lead (Junto / CLI)");
    expect(seatLabel(seatIdentity(canvas, node("loose")))).toBe("loose");
    expect(regionPathText([])).toBeUndefined();
  });

  it("finds a seat by id, or by name ignoring case, and calls a shared name ambiguous", () => {
    const seats = [...canvas.nodes.values()].filter((candidate) => candidate.kind === "agent");
    expect(findSeatByName(seats, "lead")).toMatchObject({ ok: true, node: { id: "lead" } });
    expect(findSeatByName(seats, "  CLI-Lead ")).toMatchObject({ ok: true, node: { id: "lead" } });
    expect(findSeatByName(seats, "nobody")).toEqual({ ok: false, reason: "none" });
    const twins = findSeatByName(seats, "HELPER");
    expect(twins.ok).toBe(false);
    expect(!twins.ok && twins.reason === "ambiguous" && twins.matches.map((match) => match.id)).toEqual(["twin-a", "twin-b"]);
  });
});
