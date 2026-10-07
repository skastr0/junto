/**
 * Crew fixture helper tests — the pure half of e2e/harness/crew-fixture.ts.
 * Covers fixture assembly legality (edge grammar, masks, region shape)
 * and the shared path derivation the fake seat binary and the spec side
 * must agree on. No Electron, no Playwright.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { wireGrant } from "../src/shared/model";
import { modelFixture, modelMessagesWire, modelSeat, modelNote, modelRegion, type ModelFixture } from "../e2e/harness/model";
import {
  crewSeatDir,
  crewSeatDirName,
  crewSeatsDir,
} from "../e2e/harness/crew-fixture";
import type { Sandbox } from "../e2e/harness/sandbox";

const seat = (id: string) => modelSeat({ id });

const pairFixture = (): ModelFixture =>
  modelFixture(
    [seat("a"), seat("b")],
    [modelMessagesWire("e-msg", "a", "b", [seat("a"), seat("b")])],
  );

describe("modelSeat", () => {
  it("authors an agent kind on the codex fake-tui harness", () => {
    const node = seat("peer");
    expect(node.kind).toBe("agent");
    expect(node.harness).toBe("codex");
    expect(node.bindingId).toBe("local:peer");
  });

  it("honors an explicit process-bind key", () => {
    const node = modelSeat({ id: "x", key: "local:peer-1" });
    expect(node.agentKey).toBe("local:peer-1");
    expect(node.bindingId).toBe("local:peer-1");
  });
});

describe("modelMessagesWire", () => {
  it("compiles the full messages grant by default", () => {
    const nodes = [seat("a"), seat("b")];
    const edge = modelMessagesWire("e", "a", "b", nodes);
    const grant = wireGrant(edge, new Map(nodes.map((node) => [node.id, node.kind])));
    expect(grant?.ports).toContain("msg.prompt");
    expect(grant?.ports).toContain("seat.wait");
    expect(grant?.ports).toContain("terminal.read");
    expect(grant?.ports).toContain("msg.send");
    expect(grant?.ports).toContain("msg.list");
  });

  it("attenuates the compiled grant through mask", () => {
    const nodes = [seat("a"), seat("b")];
    const edge = modelMessagesWire("e", "a", "b", nodes, [
      "msg.list",
      "msg.send",
    ]);
    const grant = wireGrant(edge, new Map(nodes.map((node) => [node.id, node.kind])));
    expect(grant?.ports).toContain("msg.send");
    expect(grant?.ports).not.toContain("terminal.read");
    expect(grant?.ports).not.toContain("seat.wait");
    expect(grant?.ports).not.toContain("msg.prompt");
  });

  it("refuses a wire into geography", () => {
    const note = modelNote("note", "plain note");
    const nodes = [seat("a"), note];
    expect(() => modelMessagesWire("bad", "a", "note", nodes)).toThrow(
      /allowed relationship/,
    );
  });
});

describe("modelRegion", () => {
  it("authors a hold region carrying its instruction", () => {
    const region = modelRegion({
      id: "zone",
      label: "crew zone", hold: true, width: 1200, height: 800,
      instruction: "stay inside the zone",
    });
    expect(region.kind).toBe("region");
    expect(region.hold).toBe(true);
    expect(region.instruction).toBe("stay inside the zone");
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

  it("roots seats under ~/.junto/crew-seats", () => {
    expect(crewSeatsDir(sandbox)).toBe(
      "/tmp/crew-home/.junto/crew-seats",
    );
    expect(crewSeatDir(sandbox, "canvas", "node")).toBe(
      "/tmp/crew-home/.junto/crew-seats/canvas--node",
    );
  });
});

describe("fake seat credential", () => {
  it("presents JUNTO_WORK_TOKEN and does not open the work token file", () => {
    const source = readFileSync("e2e/harness/crew-fixture.ts", "utf8");
    expect(source).toContain("process.env.JUNTO_WORK_TOKEN");
    expect(source).not.toContain("tokPath");
    expect(source).not.toContain('path.join(workHome, "token")');
    expect(source).not.toContain(".junto/work/token");
  });
});

describe("assembled fixture", () => {
  it("keeps every fixture edge decodable", () => {
    const doc = pairFixture();
    expect(doc.wires).toHaveLength(1);
    expect(doc.nodes).toHaveLength(2);
  });
});
