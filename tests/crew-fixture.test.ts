/**
 * Crew fixture helper tests — the pure half of e2e/harness/crew-fixture.ts.
 * Covers fixture assembly legality (edge grammar, masks, contract rules,
 * region shape) and the shared path derivation the fake seat binary and
 * the spec side must agree on. No Electron, no Playwright.
 */
import { describe, expect, it } from "vitest";
import { edgeGrant, type CanvasDoc } from "../src/shared/canvas";
import {
  crewDoc,
  crewMessagesEdge,
  crewRegionNode,
  crewReviewsEdge,
  crewRule,
  crewSeatDir,
  crewSeatDirName,
  crewSeatNode,
  crewSeatsDir,
  crewTasksNode,
  crewWorksEdge,
} from "../e2e/harness/crew-fixture";
import { taskItem } from "../e2e/harness/sandbox";
import type { Sandbox } from "../e2e/harness/sandbox";

const seat = (id: string) => crewSeatNode({ id });

const pairDoc = (): CanvasDoc =>
  crewDoc(
    [seat("a"), seat("b")],
    [crewMessagesEdge("e-msg", "a", "b", [seat("a"), seat("b")])],
  );

describe("crewSeatNode", () => {
  it("authors an agent kind on the codex fake-tui harness", () => {
    const node = seat("peer");
    expect(node.ether?.entity?.kind).toBe("agent");
    expect(node.ether?.terminal?.harness).toBe("codex");
    expect(node.ether?.terminal?.bindingId).toBe("local:peer");
  });

  it("honors an explicit process-bind key", () => {
    const node = crewSeatNode({ id: "x", key: "local:reviewer-1" });
    expect(node.ether?.entity?.name).toBe("local:reviewer-1");
    expect(node.ether?.terminal?.bindingId).toBe("local:reviewer-1");
  });
});

describe("crewMessagesEdge", () => {
  it("compiles the full messages grant by default", () => {
    const nodes = [seat("a"), seat("b")];
    const edge = crewMessagesEdge("e", "a", "b", nodes);
    const grant = edgeGrant(crewDoc(nodes, [edge]), edge);
    expect(grant?.ports).toContain("msg.prompt");
    expect(grant?.ports).toContain("seat.wait");
    expect(grant?.ports).toContain("terminal.read");
    expect(grant?.ports).toContain("msg.send");
    expect(grant?.ports).toContain("msg.list");
  });

  it("attenuates the compiled grant through mask", () => {
    const nodes = [seat("a"), seat("b")];
    const edge = crewMessagesEdge("e", "a", "b", nodes, [
      "msg.list",
      "msg.send",
    ]);
    const grant = edgeGrant(crewDoc(nodes, [edge]), edge);
    expect(grant?.ports).toContain("msg.send");
    expect(grant?.ports).not.toContain("terminal.read");
    expect(grant?.ports).not.toContain("seat.wait");
    expect(grant?.ports).not.toContain("msg.prompt");
  });

  it("refuses a wire into geography", () => {
    const note = {
      id: "note",
      type: "text" as const,
      text: "plain note",
      x: 0,
      y: 0,
      width: 240,
      height: 120,
    };
    const nodes = [seat("a"), note];
    expect(() => crewMessagesEdge("bad", "a", "note", nodes)).toThrow(
      /messages/,
    );
  });
});

describe("crewReviewsEdge", () => {
  it("compiles verdict.post only", () => {
    const nodes = [seat("reviewer"), seat("author")];
    const edge = crewReviewsEdge("r", "reviewer", "author", nodes);
    const grant = edgeGrant(crewDoc(nodes, [edge]), edge);
    expect(grant?.ports).toEqual(["verdict.post"]);
  });

  it("throws when the pair cannot hold the verb", () => {
    const board = {
      id: "board",
      type: "text" as const,
      text: "board",
      x: 0,
      y: 0,
      width: 240,
      height: 120,
      ether: { entity: { kind: "board" as const } },
    };
    const nodes = [seat("a"), board];
    expect(() => crewReviewsEdge("r", "a", "board", nodes)).toThrow(/reviews/);
  });
});

describe("crewWorksEdge", () => {
  it("compiles the claimable task path from sink to seat", () => {
    const sink = crewTasksNode({ id: "sink" });
    const nodes = [sink, seat("a")];
    const edge = crewWorksEdge("w", "sink", "a", nodes);
    const grant = edgeGrant(crewDoc(nodes, [edge]), edge);
    expect(grant?.claimable).toBe(true);
    expect(grant?.ports).toContain("tasks.list");
  });
});

describe("crewTasksNode + crewRule", () => {
  it("carries the operator contract including requires-review", () => {
    const node = crewTasksNode({
      id: "sink",
      items: [taskItem("t-1", "do the thing")],
      contract: {
        rules: [crewRule("r1", "must be reviewed", "requires-review")],
      },
    });
    expect(node.ether?.tasks?.contract?.rules?.[0]).toEqual({
      id: "r1",
      text: "must be reviewed",
      kind: "requires-review",
    });
  });

  it("defaults a rule to a plain statement", () => {
    expect(crewRule("r2", "prose")).toEqual({ id: "r2", text: "prose" });
  });
});

describe("crewRegionNode", () => {
  it("authors a hold region with a stacked contract", () => {
    const region = crewRegionNode({
      id: "zone",
      label: "reviewed zone",
      rules: [crewRule("zr", "region review", "requires-review")],
    });
    expect(region.type).toBe("group");
    expect(region.ether?.region?.hold).toBe(true);
    expect(region.ether?.region?.contract?.rules?.[0]?.kind).toBe(
      "requires-review",
    );
  });
});

describe("seat dir derivation", () => {
  const sandbox = {
    homeDir: "/tmp/crew-home",
    root: "/tmp/crew-root",
  } as Sandbox;

  it("sanitizes canvas:node the same way the fake binary does", () => {
    expect(crewSeatDirName("crew mail", "seat/a")).toBe("crew--mail--seat--a");
    expect(crewSeatDirName("c", "n.1")).toBe("c--n.1");
  });

  it("roots seats under ~/.vellum-command/crew-seats", () => {
    expect(crewSeatsDir(sandbox)).toBe(
      "/tmp/crew-home/.vellum-command/crew-seats",
    );
    expect(crewSeatDir(sandbox, "canvas", "node")).toBe(
      "/tmp/crew-home/.vellum-command/crew-seats/canvas--node",
    );
  });
});

describe("assembled doc", () => {
  it("keeps every fixture edge decodable", () => {
    const doc = pairDoc();
    expect(doc.edges).toHaveLength(1);
    expect(doc.nodes).toHaveLength(2);
  });
});
