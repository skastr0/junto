import { describe, expect, it } from "vitest";
import { asNodeId, asWireId, wireGrant, wireKinds, type Wire } from "../src/shared/model";

const wire = (verb: Wire["verb"], from: string, to: string, mask?: Wire["mask"]): Wire => ({
  id: asWireId(`${from}-${to}`),
  from: asNodeId(from),
  to: asNodeId(to),
  verb,
  ...(mask === undefined ? {} : { mask }),
});

const kinds = wireKinds([
  { id: "lead", kind: "agent" },
  { id: "worker", kind: "agent" },
  { id: "queue", kind: "task" },
  { id: "memo", kind: "note" },
]);

describe("wireGrant", () => {
  it("opens the ports its verb grants between the two kinds", () => {
    expect(wireGrant(wire("messages", "lead", "worker"), kinds)?.ports).toEqual([
      "msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read",
    ]);
    expect(wireGrant(wire("works", "queue", "worker"), kinds)).toMatchObject({ claimable: true });
  });

  it("lets a mask take ports away and never add one", () => {
    const masked = wireGrant(
      wire("messages", "lead", "worker", ["msg.list", "tasks.claim"]),
      kinds,
    );
    expect(masked?.ports).toEqual(["msg.list"]);
    expect(wireGrant(wire("messages", "lead", "worker", []), kinds)?.ports).toEqual([]);
  });

  it("grants nothing when the kinds cannot hold the verb or an end is missing", () => {
    expect(wireGrant(wire("works", "worker", "queue"), kinds)).toBeUndefined();
    expect(wireGrant(wire("messages", "lead", "memo"), kinds)).toBeUndefined();
    expect(wireGrant(wire("messages", "lead", "gone"), kinds)).toBeUndefined();
  });
});
