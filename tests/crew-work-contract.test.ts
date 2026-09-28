import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MsgPromptArgs, MsgSendArgs, decodeWorkRequest,
} from "../src/shared/work-control";
import { admitWorkTarget } from "../src/main/junto/work/authz";
import type { CanvasDoc } from "../src/shared/canvas";

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
    const doc: CanvasDoc = {
      nodes: ["author", "peer"].map((id) => ({
        id, type: "text", text: id, x: 0, y: 0, width: 200, height: 100,
        ether: { entity: { kind: "agent", name: id } },
      })),
      edges: [
        { id: "m", fromNode: "author", toNode: "peer", ether: { verb: "messages", mask: ["terminal.read"] } },
      ],
    };
    expect(Result.isSuccess(admitWorkTarget(doc, "author", "peer", "seat.read"))).toBe(true);
    expect(Result.isFailure(admitWorkTarget(doc, "author", "peer", "msg.prompt"))).toBe(true);
  });
});
