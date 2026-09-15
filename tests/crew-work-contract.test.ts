import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MsgPromptArgs, MsgSendArgs, WorkErrorBody, decodeWorkRequest,
} from "../src/shared/work-control";
import { admitWorkTarget } from "../src/main/vellum-command/work/authz";
import type { CanvasDoc } from "../src/shared/canvas";

describe("crew work wire contract", () => {
  it("keeps prompt creation distinct from same-id retry and rejects identity forgery", () => {
    const decode = Schema.decodeUnknownResult(MsgPromptArgs, { onExcessProperty: "error" });
    expect(Result.isSuccess(decode({ target: "peer", text: "Review now" }))).toBe(true);
    expect(Result.isSuccess(decode({ target: "peer", messageId: "m1", fallback: "notice" }))).toBe(true);
    for (const args of [
      { target: "peer", text: "changed body", messageId: "m1" },
      { target: "peer", text: "hello", senderGeneration: "forged" },
      { target: "peer", text: "hello", fromSeat: "operator" },
      { target: "peer", messageId: "" },
      { target: "peer", text: "hello", fallback: "interrupt" },
    ]) expect(Result.isFailure(decode(args))).toBe(true);
  });

  it("accepts typed evidence refs and durable retry details on the same protocol", () => {
    const args = Schema.decodeUnknownSync(MsgSendArgs)({
      target: "peer", text: "Patch ready", refs: [{ kind: "file", path: "src/file.ts", line: 9 }],
    });
    expect(args.refs).toEqual([{ kind: "file", path: "src/file.ts", line: 9 }]);
    expect(Schema.decodeUnknownSync(WorkErrorBody)({
      type: "SeatBusy", message: "Recipient is working", details: { messageId: "m1", retryable: true, reason: "seat-busy" },
    }).details?.messageId).toBe("m1");
    for (const op of ["msg.prompt", "msg.sent", "seat.wait", "seat.read", "tasks.wait", "verdict.post"]) {
      expect(Result.isSuccess(decodeWorkRequest({ token: "test", op, args: {} }))).toBe(true);
    }
  });

  it("admits peer read independently from prompt and enforces review direction at work ingress", () => {
    const doc: CanvasDoc = {
      nodes: ["author", "reviewer"].map((id) => ({
        id, type: "text", text: id, x: 0, y: 0, width: 200, height: 100,
        ether: { entity: { kind: "agent", name: id } },
      })),
      edges: [
        { id: "m", fromNode: "author", toNode: "reviewer", ether: { verb: "messages", mask: ["terminal.read"] } },
        { id: "r", fromNode: "reviewer", toNode: "author", ether: { verb: "reviews" } },
      ],
    };
    expect(Result.isSuccess(admitWorkTarget(doc, "author", "reviewer", "seat.read"))).toBe(true);
    expect(Result.isFailure(admitWorkTarget(doc, "author", "reviewer", "msg.prompt"))).toBe(true);
    expect(Result.isFailure(admitWorkTarget(doc, "author", "reviewer", "verdict.post"))).toBe(true);
    expect(Result.isSuccess(admitWorkTarget(doc, "reviewer", "author", "verdict.post"))).toBe(true);
  });
});
