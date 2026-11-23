import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MsgPromptArgs, MsgSendArgs, decodeWorkRequest,
} from "../src/shared/work-control";
import { admitWorkTarget, connectedCapabilities } from "../src/core/work/authz";
import { asNodeId, type Peer } from "../src/shared/model";
import { OTHER_MACHINE } from "./support/machines";
import { canvasOf, page, seat, wire } from "./support/model-nodes";

/** Another machine's seat, as a copy of a canvas holds it. */
const peerSeat = (id: string): Peer => ({
  kind: "peer",
  id: asNodeId(id),
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  z: 0,
  label: id as Peer["label"],
  host: OTHER_MACHINE as Peer["host"],
  seatId: `seat_${"b".repeat(64)}` as Peer["seatId"],
});

describe("crew work wire contract", () => {
  it("takes a prompt as target and text, and rejects identity forgery", () => {
    const decode = Schema.decodeUnknownResult(MsgPromptArgs, { onExcessProperty: "error" });
    expect(Result.isSuccess(decode({ target: "peer", text: "Review now" }))).toBe(true);
    for (const args of [
      { target: "peer", text: "hello", senderGeneration: "forged" },
      { target: "peer", text: "hello", fromSeat: "operator" },
    ]) expect(Result.isFailure(decode(args))).toBe(true);
  });

  it("accepts typed evidence refs on the same protocol", () => {
    const args = Schema.decodeUnknownSync(MsgSendArgs)({
      target: "peer", text: "Patch ready", refs: [{ kind: "file", path: "src/file.ts", line: 9 }],
    });
    expect(args.refs).toEqual([{ kind: "file", path: "src/file.ts", line: 9 }]);
    for (const op of ["msg.prompt", "msg.sent", "seat.wait", "seat.read"]) {
      expect(Result.isSuccess(decodeWorkRequest({ token: "test", op, args: {} }))).toBe(true);
    }
  });

  it("admits peer read independently from prompt at work ingress", () => {
    const canvas = canvasOf(
      [seat("author"), seat("peer")],
      [wire("m", "author", "peer", "messages", { mask: ["terminal.read"] })],
    );
    expect(Result.isSuccess(admitWorkTarget(canvas, "author", "peer", "seat.read"))).toBe(true);
    expect(Result.isFailure(admitWorkTarget(canvas, "author", "peer", "msg.prompt"))).toBe(true);
  });

  it("admits mail to a peer, a seat of another machine, and nothing else", () => {
    const canvas = canvasOf(
      [seat("author"), peerSeat("away")],
      [wire("m", "author", "away", "messages")],
    );
    // What onboard lists for the caller: a seat, with mail as its one grant.
    expect(connectedCapabilities(canvas, "author")).toMatchObject([
      { id: "away", kind: "agent", role: "actor", grants: ["msg.send"] },
    ]);
    const sent = admitWorkTarget(canvas, "author", "away", "msg.send");
    expect(Result.isSuccess(sent)).toBe(true);
    for (const op of ["msg.prompt", "seat.read", "seat.wait", "thread.list", "thread.show"] as const) {
      const refused = admitWorkTarget(canvas, "author", "away", op);
      expect(Result.isFailure(refused)).toBe(true);
      if (Result.isFailure(refused)) expect(refused.failure.details?.reason).toBe("other_machine");
    }
  });

  it("admits a seat's threads on threads.read alone, and refuses a node that is not a seat", () => {
    const canvas = canvasOf(
      [seat("author"), seat("threads"), seat("screen"), page("site")],
      [
        wire("t", "author", "threads", "messages", { mask: ["threads.read"] }),
        wire("s", "author", "screen", "messages", { mask: ["terminal.read"] }),
        wire("p", "author", "site", "navigates"),
      ],
    );
    for (const op of ["thread.list", "thread.show"] as const) {
      expect(Result.isSuccess(admitWorkTarget(canvas, "author", "threads", op)), op).toBe(true);
      expect(Result.isFailure(admitWorkTarget(canvas, "author", "screen", op)), op).toBe(true);
      expect(Result.isFailure(admitWorkTarget(canvas, "author", "site", op)), op).toBe(true);
    }
    expect(Result.isFailure(admitWorkTarget(canvas, "author", "threads", "seat.read"))).toBe(true);
    expect(Result.isSuccess(admitWorkTarget(canvas, "author", "screen", "seat.read"))).toBe(true);
  });
});
