import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MsgPromptArgs, MsgSendArgs, VerdictPostArgs, WorkErrorBody, decodeWorkRequest,
} from "../src/shared/work-control";
import { admitWorkTarget } from "../src/main/junto/work/authz";
import type { CanvasDoc } from "../src/shared/canvas";

describe("crew work wire contract", () => {
  it("requires exact review subject expectations and rejects asserted reviewer identity", () => {
    const decode = Schema.decodeUnknownResult(VerdictPostArgs);
    const valid = {
      target: "task-board", kind: "green",
      subject: { kind: "task", taskId: "task-1", epoch: 2, subjectHash: "a".repeat(64) },
    };
    expect(Result.isSuccess(decode(valid))).toBe(true);
    for (const args of [
      { ...valid, reviewerSeatId: "forged" },
      { ...valid, subject: { kind: "task", taskId: "task-1" } },
      { ...valid, subject: { ...valid.subject, epoch: -1 } },
      { ...valid, subject: { ...valid.subject, subjectHash: "latest" } },
      { ...valid, subject: { kind: "commit", sha: "a".repeat(41) } },
    ]) expect(Result.isFailure(decode(args))).toBe(true);
  });
  it("takes a prompt as target and text only, and rejects retry fields and identity forgery", () => {
    const decode = Schema.decodeUnknownResult(MsgPromptArgs, { onExcessProperty: "error" });
    expect(Result.isSuccess(decode({ target: "peer", text: "Review now" }))).toBe(true);
    for (const args of [
      { target: "peer", messageId: "m1" },
      { target: "peer", text: "hello", fallback: "notice" },
      { target: "peer", text: "hello", senderGeneration: "forged" },
      { target: "peer", text: "hello", fromSeat: "operator" },
    ]) expect(Result.isFailure(decode(args))).toBe(true);
  });

  it("accepts typed evidence refs, and no mail refusal exists on the wire", () => {
    const args = Schema.decodeUnknownSync(MsgSendArgs)({
      target: "peer", text: "Patch ready", refs: [{ kind: "file", path: "src/file.ts", line: 9 }],
    });
    expect(args.refs).toEqual([{ kind: "file", path: "src/file.ts", line: 9 }]);
    expect(Result.isFailure(Schema.decodeUnknownResult(WorkErrorBody)({
      type: "SeatBusy", message: "Recipient is working",
    }))).toBe(true);
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
