import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MsgPromptArgs, MsgSendArgs, decodeWorkRequest,
} from "../src/shared/work-control";
import { admitWorkTarget } from "../src/main/junto/work/authz";
import { canvasOf, seat, wire } from "./support/model-nodes";

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
});
