import { describe, expect, it } from "vitest";
import { Result } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import type { ClaimDef, TaskClaim } from "../src/shared/work-model";
import {
  admissionLabel,
  formatHops,
  stationLine,
} from "../src/renderer/components/claims/creation/station-map";
import {
  claimsAt,
  formatProfile,
  groupLineLaw,
  groupStopsByHop,
  lineLaw,
  lineProfile,
  REGION_LAW_SCOPE,
  SINK_LAW_SCOPE,
  pinsAt,
  pruneToLine,
  replacePinsAt,
  strandedPins,
} from "../src/renderer/components/claims/creation/station-pins";

// Pure derivation behind the task creation metro map: the line a raised task
// can travel, the standing law at each stop, and station-addressed pins.

const claim = (id: string, severity: "hard" | "soft" = "hard"): ClaimDef => ({
  id,
  text: `claim ${id}`,
  severity,
});

const sink = (
  id: string,
  contract?: Record<string, unknown>,
  position: { x: number; y: number } = { x: 0, y: 0 },
) => ({
  id,
  type: "text" as const,
  text: id,
  x: position.x,
  y: position.y,
  width: 200,
  height: 80,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [],
      stationName: id,
      ...(contract ? { contract } : {}),
    },
  },
});

const region = (
  id: string,
  label: string,
  claims: ReadonlyArray<ClaimDef>,
  rect: { x: number; y: number; width: number; height: number },
) => ({
  id,
  type: "group" as const,
  label,
  ...rect,
  ether: { region: { contract: { claims } } },
});

const flowEdge = (id: string, fromNode: string, toNode: string) => ({
  id,
  fromNode,
  toNode,
  ether: { flow: { source: fromNode, destination: toNode } },
});

const doc = (nodes: ReadonlyArray<unknown>, edges: ReadonlyArray<unknown>): CanvasDoc =>
  Result.getOrThrow(decodeCanvasDoc({ nodes, edges }));

describe("stationLine", () => {
  it("walks the origin first, then destinations breadth-first", () => {
    const board = doc(
      [sink("intake"), sink("build"), sink("review"), sink("ship")],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    const line = stationLine(board, "intake");
    expect(line.map((stop) => stop.nodeId)).toEqual([
      "intake",
      "build",
      "review",
      "ship",
    ]);
    expect(line.map((stop) => stop.hops)).toEqual([0, 1, 2, 2]);
    expect(line[0]!.origin).toBe(true);
    expect(line[1]!.origin).toBe(false);
  });

  it("marks terminals and forks", () => {
    const board = doc(
      [sink("intake"), sink("build"), sink("review"), sink("ship")],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    const line = stationLine(board, "intake");
    expect(line[1]!.destinations).toEqual(["review", "ship"]);
    expect(line[1]!.terminal).toBe(false);
    expect(line[2]!.terminal).toBe(true);
    expect(line[3]!.terminal).toBe(true);
  });

  it("flags where reading order jumps to another branch", () => {
    const board = doc(
      [sink("intake"), sink("build"), sink("review"), sink("ship")],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "ship"),
      ],
    );
    const line = stationLine(board, "intake");
    // intake -> build -> review is a straight track; ship follows review in
    // reading order but is fed by build, so the drawn line breaks there.
    expect(line.map((stop) => stop.linkedToPrevious)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("keeps the shortest hop count for a station reachable two ways", () => {
    const board = doc(
      [sink("intake"), sink("fast"), sink("slow"), sink("ship")],
      [
        flowEdge("e1", "intake", "fast"),
        flowEdge("e2", "intake", "slow"),
        flowEdge("e3", "fast", "ship"),
        flowEdge("e4", "slow", "ship"),
      ],
    );
    const line = stationLine(board, "intake");
    expect(line.map((stop) => stop.nodeId)).toEqual([
      "intake",
      "fast",
      "slow",
      "ship",
    ]);
    expect(line[3]!.hops).toBe(2);
  });

  it("terminates on a flowless sink with the origin alone", () => {
    const board = doc([sink("solo")], []);
    const line = stationLine(board, "solo");
    expect(line).toHaveLength(1);
    expect(line[0]!.terminal).toBe(true);
    expect(line[0]!.linkedToPrevious).toBe(true);
  });

  it("reads the standing law, region stack first, then the sink's own", () => {
    const board = doc(
      [
        region("outer", "Factory", [claim("r1")], {
          x: -100,
          y: -100,
          width: 900,
          height: 900,
        }),
        region("inner", "Line A", [claim("r2", "soft")], {
          x: -50,
          y: -50,
          width: 400,
          height: 400,
        }),
        sink("build", { claims: [claim("s1")] }, { x: 0, y: 0 }),
      ],
      [],
    );
    const line = stationLine(board, "build");
    expect(line[0]!.law.map((entry) => entry.claim.id)).toEqual(["r1", "r2", "s1"]);
    expect(line[0]!.law.map((entry) => entry.provenance.kind)).toEqual([
      "region",
      "region",
      "sink",
    ]);
    expect(line[0]!.hard).toBe(2);
    expect(line[0]!.soft).toBe(1);
  });

  it("carries the inbound posture and admission of each stop", () => {
    const board = doc(
      [
        sink("intake"),
        sink("review", {
          instruction: "Read it against the contract.",
          inbound: {
            description: "Anything with a diff to check.",
            instruction: "Triage by blast radius.",
            admission: "operator-gated",
            claimableAfterMs: 60000,
          },
        }),
      ],
      [flowEdge("e1", "intake", "review")],
    );
    const line = stationLine(board, "intake");
    expect(line[0]!.admission).toBe("auto");
    expect(line[1]).toMatchObject({
      instruction: "Read it against the contract.",
      description: "Anything with a diff to check.",
      triage: "Triage by blast radius.",
      admission: "operator-gated",
      bakeMs: 60000,
    });
  });
});

describe("formatHops and admissionLabel", () => {
  it("says the distance in words", () => {
    expect(formatHops(0)).toBe("here");
    expect(formatHops(1)).toBe("next stop");
    expect(formatHops(3)).toBe("3 stops on");
  });

  it("says how a stop admits arrivals", () => {
    expect(admissionLabel("auto")).toBe("Immediate");
    expect(admissionLabel("operator-gated")).toBe("Approval");
    expect(admissionLabel("operator-owned")).toBe("Mine");
  });
});

const pin = (
  id: string,
  station: string,
  severity: "hard" | "soft" = "hard",
): TaskClaim => ({ id, text: `pin ${id}`, severity, station });

describe("station pins", () => {
  it("reads the pins addressed to one stop", () => {
    const pins = [pin("a", "build"), pin("b", "ship"), pin("c", "build")];
    expect(pinsAt(pins, "build").map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(claimsAt(pins, "build")).toEqual([
      { id: "a", text: "pin a", severity: "hard" },
      { id: "c", text: "pin c", severity: "hard" },
    ]);
  });

  it("replaces one station's pins in place, leaving the others alone", () => {
    const pins = [pin("a", "build"), pin("b", "ship"), pin("c", "build")];
    const next = replacePinsAt(pins, "build", [claim("z", "soft")]);
    expect(next).toEqual([
      { id: "z", text: "claim z", severity: "soft", station: "build" },
      pin("b", "ship"),
    ]);
  });

  it("appends when a station had no pins yet", () => {
    const next = replacePinsAt([pin("b", "ship")], "build", [claim("z")]);
    expect(next.map((entry) => entry.station)).toEqual(["ship", "build"]);
  });

  it("clears a station by replacing it with nothing", () => {
    const pins = [pin("a", "build"), pin("b", "ship")];
    expect(replacePinsAt(pins, "build", [])).toEqual([pin("b", "ship")]);
  });

  it("finds and prunes pins whose station left the line", () => {
    const board = doc(
      [sink("intake"), sink("build")],
      [flowEdge("e1", "intake", "build")],
    );
    const line = stationLine(board, "intake");
    const pins = [pin("a", "build"), pin("b", "gone")];
    expect(strandedPins(pins, line)).toEqual([pin("b", "gone")]);
    expect(pruneToLine(pins, line)).toEqual([pin("a", "build")]);
  });
});

describe("lineProfile", () => {
  it("counts one ambient claim once across a five-stop fork", () => {
    const ambient = claim("ambient");
    const board = doc(
      [
        region("factory", "Factory", [ambient], {
          x: -100,
          y: -100,
          width: 1500,
          height: 800,
        }),
        sink("intake", undefined, { x: 0, y: 0 }),
        sink("build", undefined, { x: 250, y: 0 }),
        sink("review", undefined, { x: 500, y: 0 }),
        sink("security", undefined, { x: 500, y: 200 }),
        sink("ship", undefined, { x: 800, y: 100 }),
      ],
      [
        flowEdge("e1", "intake", "build"),
        flowEdge("e2", "build", "review"),
        flowEdge("e3", "build", "security"),
        flowEdge("e4", "review", "ship"),
        flowEdge("e5", "security", "ship"),
      ],
    );
    const line = stationLine(board, "intake");
    expect(line).toHaveLength(5);
    expect(line.every((stop) => stop.law.some((entry) => entry.claim.id === "ambient"))).toBe(true);
    expect(lineLaw(line).map((entry) => entry.claim.id)).toEqual(["ambient"]);
    expect(groupLineLaw(line)).toEqual([
      expect.objectContaining({
        kind: "region",
        label: "Factory",
        scope: REGION_LAW_SCOPE,
        claims: [expect.objectContaining({ claim: expect.objectContaining({ id: "ambient" }) })],
      }),
    ]);
    expect(groupStopsByHop(line).map((stage) => stage.stops.length)).toEqual([
      1,
      1,
      2,
      1,
    ]);
    const profile = lineProfile(line);
    expect(profile).toEqual({
      stops: 5,
      standing: 1,
      hard: 1,
      soft: 0,
      pinned: 0,
    });
    expect(formatProfile(profile)).toBe("5 stops, 1 claim, 1 hard");
  });

  it("counts stops, standing law, and pins in one glance", () => {
    const board = doc(
      [
        sink("intake", { claims: [claim("s1")] }),
        sink("build", { claims: [claim("s2"), claim("s3", "soft")] }),
      ],
      [flowEdge("e1", "intake", "build")],
    );
    const line = stationLine(board, "intake");
    const profile = lineProfile(line, [pin("p1", "build"), pin("p2", "gone", "soft")]);
    expect(profile).toEqual({
      stops: 2,
      standing: 3,
      hard: 3,
      soft: 1,
      pinned: 1,
    });
    expect(formatProfile(profile)).toBe("2 stops, 4 claims, 3 hard");
  });

  it("says so when nothing stands on the line", () => {
    const board = doc([sink("solo")], []);
    expect(formatProfile(lineProfile(stationLine(board, "solo")))).toBe(
      "1 stop, no standing claims",
    );
  });
});

describe("groupLineLaw", () => {
  it("splits region law from per-station sink law and names both", () => {
    const board = doc(
      [
        region("factory", "Factory", [claim("ambient")], {
          x: -100,
          y: -100,
          width: 900,
          height: 900,
        }),
        sink("intake", { claims: [claim("intake-gate")] }, { x: 0, y: 0 }),
        sink("build", { claims: [claim("build-gate")] }, { x: 250, y: 0 }),
      ],
      [flowEdge("e1", "intake", "build")],
    );
    const groups = groupLineLaw(stationLine(board, "intake"));
    expect(groups.map((group) => [group.kind, group.label, group.scope])).toEqual([
      ["region", "Factory", REGION_LAW_SCOPE],
      ["sink", "intake", SINK_LAW_SCOPE],
      ["sink", "build", SINK_LAW_SCOPE],
    ]);
    expect(groups.map((group) => group.claims.map((entry) => entry.claim.id))).toEqual([
      ["ambient"],
      ["intake-gate"],
      ["build-gate"],
    ]);
  });
});
